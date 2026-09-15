-- PACE PDM Migration 056: implement_eco stops inventing part revisions, and
--                          records every file it releases
--
-- Replaces the function from migration 049. Everything not named below is
-- unchanged, including the BOM branch that src/lib/status-flows.test.ts reads.
--
-- ── 1. The revision a part becomes comes from the ECO item (AUD-003 CHG-3) ─
--
-- When an item had no "toRevision", the function bumped the part itself:
--
--     ELSIF v_part."revision" ~ '^[A-Y]$' THEN
--       v_next_rev := chr(ascii(v_part."revision") + 1);
--
-- Anything but a single letter A–Y raised — R3, 01, Z — and the letters it
-- did produce included I, O, Q, S and X, which ASME Y14.35 reserves. It
-- raised at implementation, after approval, where the ECO could not be
-- edited, deleted or moved anywhere but IMPLEMENTED: stuck for good.
--
-- The app now owns the rule, in one place (src/lib/revision.ts, which already
-- skips the reserved letters and follows R2 → R3). Submitting an ECO writes
-- the revision onto each part item that has none, so the approvers see the
-- letter they approve; the implement route does the same for an ECO submitted
-- before this change. So a blank toRevision here means something called the
-- function without going through the app, and it refuses rather than guess.
-- It also refuses releasing a part as the revision it is already at, which
-- the app checks too.
--
-- An ECO that fails either way can now be rejected from APPROVED by an
-- approver and reopened as a draft (src/lib/status-flows.ts).
--
-- ── 2. A file released through a part gets its own audit row ─────────────
--
-- A file listed on the ECO got a 'file.eco_implemented' row. A file released
-- because it is linked to a listed part got nothing — only the part's
-- 'part.eco_released' row — so the file's own history did not show that it
-- was ever released, or by which ECO. It now gets the same row, naming the
-- part it came through.
--
-- The listed file's row also said "transitioned": true for a file left alone
-- because it was checked out. It now says what happened. (The app refuses to
-- implement while a file is checked out, so this is the backstop.)
--
-- ── Order of deployment ──────────────────────────────────────────────────
--
-- Deploy the app first, then apply this. The new app works with the old
-- function: it always passes a revision, which 049 honours. The old app with
-- the new function would refuse to implement an ECO whose part items have no
-- revision until the deploy lands — refused, not released wrongly.
--
-- To check which version is live:
--
--   select position('chr(ascii' in prosrc) > 0 as still_bumps,
--          (length(prosrc) - length(replace(prosrc, 'file.eco_implemented', '')))
--            / length('file.eco_implemented') as file_audit_rows
--   from pg_proc where proname = 'implement_eco';
--
-- still_bumps false and file_audit_rows 2 means this migration is applied.
--
-- Not verified against the live database; this session cannot query it.
--
-- Idempotent: DROP FUNCTION IF EXISTS, then CREATE OR REPLACE.

DROP FUNCTION IF EXISTS implement_eco(TEXT, TEXT);

CREATE OR REPLACE FUNCTION implement_eco(p_eco_id TEXT, p_user_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_eco RECORD;
  v_user_tenant TEXT;
  v_item RECORD;
  v_file RECORD;
  v_part RECORD;
  v_bom RECORD;
  v_pf RECORD;
  v_version_id TEXT;
  v_next_rev TEXT;
  v_files_transitioned INT := 0;
  v_files_stamped INT := 0;
  v_parts_released INT := 0;
  v_boms_released INT := 0;
  v_boms_already INT := 0;
  v_now TIMESTAMP(3) := CURRENT_TIMESTAMP;
BEGIN
  SELECT "tenantId" INTO v_user_tenant FROM "tenant_users" WHERE "id" = p_user_id;
  IF v_user_tenant IS NULL THEN
    RAISE EXCEPTION 'Unknown user %', p_user_id USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_eco FROM "ecos" WHERE "id" = p_eco_id FOR UPDATE;
  IF v_eco IS NULL THEN
    RAISE EXCEPTION 'ECO not found' USING ERRCODE = '22023';
  END IF;
  IF v_eco."tenantId" <> v_user_tenant THEN
    RAISE EXCEPTION 'ECO not found' USING ERRCODE = '22023';
  END IF;
  IF v_eco."status" <> 'APPROVED' THEN
    RAISE EXCEPTION 'ECO must be in APPROVED status to implement (current: %)', v_eco."status"
      USING ERRCODE = '22023';
  END IF;

  -- Each row is exactly one of a part item, a file item or a BOM item —
  -- guaranteed by eco_items_target_one above.
  FOR v_item IN
    SELECT "id", "partId", "fileId", "bomId", "toRevision"
      FROM "eco_items"
      WHERE "ecoId" = p_eco_id
  LOOP
    -- ─── Part item: bump revision, cascade to linked files ────────────
    IF v_item."partId" IS NOT NULL THEN
      SELECT * INTO v_part FROM "parts" WHERE "id" = v_item."partId" FOR UPDATE;
      IF v_part IS NULL THEN
        CONTINUE; -- Part was deleted after ECO was created; skip silently
      END IF;
      IF v_part."tenantId" <> v_user_tenant THEN
        RAISE EXCEPTION 'ECO references a part from another tenant — refusing'
          USING ERRCODE = '22023';
      END IF;

      -- The item carries the revision the part becomes: submitting the ECO
      -- writes it by the rules in src/lib/revision.ts, and the implement
      -- route writes it for an ECO submitted before that. This used to bump
      -- by incrementing the letter itself. See the header.
      v_next_rev := NULLIF(trim(COALESCE(v_item."toRevision", '')), '');
      IF v_next_rev IS NULL THEN
        RAISE EXCEPTION
          'ECO % lists part % without the revision it becomes. Implement it from the app, which sets one.',
          v_eco."ecoNumber", v_part."partNumber"
          USING ERRCODE = '22023';
      END IF;
      IF lower(v_next_rev) = lower(COALESCE(trim(v_part."revision"), '')) THEN
        RAISE EXCEPTION
          'ECO % would release part % as revision %, which it is already at.',
          v_eco."ecoNumber", v_part."partNumber", v_next_rev
          USING ERRCODE = '22023';
      END IF;

      UPDATE "parts"
        SET "revision" = v_next_rev,
            "lifecycleState" = 'Released',
            "updatedAt" = v_now
        WHERE "id" = v_part."id";

      UPDATE "eco_items"
        SET "fromRevision" = COALESCE("fromRevision", v_part."revision"),
            "toRevision"   = v_next_rev
        WHERE "id" = v_item."id";

      FOR v_pf IN
        SELECT "fileId" FROM "part_files" WHERE "partId" = v_part."id"
      LOOP
        SELECT * INTO v_file FROM "files" WHERE "id" = v_pf."fileId" FOR UPDATE;
        IF v_file IS NULL THEN CONTINUE; END IF;
        IF v_file."tenantId" <> v_user_tenant THEN CONTINUE; END IF;

        IF v_file."lifecycleState" = 'WIP' AND NOT v_file."isCheckedOut" THEN
          UPDATE "files"
            SET "lifecycleState" = 'Released',
                "isFrozen" = TRUE,
                "updatedAt" = v_now
            WHERE "id" = v_file."id";
          v_files_transitioned := v_files_transitioned + 1;
        END IF;

        UPDATE "file_versions"
          SET "ecoId" = p_eco_id
          WHERE "fileId" = v_file."id"
            AND "version" = v_file."currentVersion"
            AND "ecoId" IS NULL
          RETURNING "id" INTO v_version_id;
        IF v_version_id IS NOT NULL THEN
          v_files_stamped := v_files_stamped + 1;
        END IF;

        -- The same row a listed file gets, naming the part it came through.
        -- Without it the file's own history showed no release at all.
        INSERT INTO "audit_logs" ("id", "tenantId", "userId", "action", "entityType", "entityId", "details", "createdAt")
        VALUES (
          gen_random_uuid()::text,
          v_user_tenant,
          p_user_id,
          'file.eco_implemented',
          'file',
          v_file."id",
          jsonb_build_object(
            'name', v_file."name",
            'revision', v_file."revision",
            'version', v_file."currentVersion",
            'ecoId', p_eco_id,
            'ecoNumber', v_eco."ecoNumber",
            'transitioned', v_file."lifecycleState" = 'WIP' AND NOT v_file."isCheckedOut",
            'partId', v_part."id",
            'partNumber', v_part."partNumber"
          ),
          v_now
        );
      END LOOP;

      INSERT INTO "audit_logs" ("id", "tenantId", "userId", "action", "entityType", "entityId", "details", "createdAt")
      VALUES (
        gen_random_uuid()::text,
        v_user_tenant,
        p_user_id,
        'part.eco_released',
        'part',
        v_part."id",
        jsonb_build_object(
          'partNumber', v_part."partNumber",
          'name', v_part."name",
          'fromRevision', v_part."revision",
          'toRevision', v_next_rev,
          'ecoId', p_eco_id,
          'ecoNumber', v_eco."ecoNumber"
        ),
        v_now
      );
      v_parts_released := v_parts_released + 1;

    -- ─── BOM item: release the revision this ECO carries ──────────────
    ELSIF v_item."bomId" IS NOT NULL THEN
      SELECT * INTO v_bom FROM "boms" WHERE "id" = v_item."bomId" FOR UPDATE;
      IF v_bom IS NULL THEN
        CONTINUE; -- BOM deleted after the ECO was authored; skip silently
      END IF;
      IF v_bom."tenantId" <> v_user_tenant THEN
        RAISE EXCEPTION 'ECO references a BOM from another tenant — refusing'
          USING ERRCODE = '22023';
      END IF;
      IF v_bom."deletedAt" IS NOT NULL THEN
        CONTINUE;
      END IF;

      IF v_bom."status" = 'RELEASED' THEN
        -- Already released by hand before the ECO was implemented. Nothing
        -- to do, and not an error — this is what makes a re-run safe.
        v_boms_already := v_boms_already + 1;

      ELSIF v_bom."status" = 'OBSOLETE' THEN
        RAISE EXCEPTION
          'ECO % carries BOM % rev % which is OBSOLETE — revise it before implementing',
          v_eco."ecoNumber", v_bom."name", v_bom."revision"
          USING ERRCODE = '22023';

      ELSE
        -- DRAFT / IN_REVIEW / APPROVED. See the header note on why this
        -- crosses BOM_STATUS_FLOW deliberately.
        UPDATE "boms"
          SET "status" = 'RELEASED',
              "updatedAt" = v_now
          WHERE "id" = v_bom."id";

        -- Retire the revision this one came from. Mirrors the release
        -- branch of PUT /api/boms/[bomId].
        IF v_bom."previousRevisionId" IS NOT NULL THEN
          UPDATE "boms"
            SET "supersededById" = v_bom."id",
                "status" = CASE WHEN "status" = 'RELEASED' THEN 'OBSOLETE' ELSE "status" END,
                "updatedAt" = v_now
            WHERE "id" = v_bom."previousRevisionId"
              AND "tenantId" = v_user_tenant;
        END IF;

        UPDATE "eco_items"
          SET "toRevision" = COALESCE("toRevision", v_bom."revision")
          WHERE "id" = v_item."id";

        INSERT INTO "audit_logs" ("id", "tenantId", "userId", "action", "entityType", "entityId", "details", "createdAt")
        VALUES (
          gen_random_uuid()::text,
          v_user_tenant,
          p_user_id,
          'bom.eco_released',
          'bom',
          v_bom."id",
          jsonb_build_object(
            'name', v_bom."name",
            'revision', v_bom."revision",
            'fromStatus', v_bom."status",
            'previousRevisionId', v_bom."previousRevisionId",
            'ecoId', p_eco_id,
            'ecoNumber', v_eco."ecoNumber"
          ),
          v_now
        );
        v_boms_released := v_boms_released + 1;
      END IF;

    -- ─── File item: unchanged behavior from migration 011 ─────────────
    ELSE
      SELECT * INTO v_file FROM "files" WHERE "id" = v_item."fileId" FOR UPDATE;
      IF v_file IS NULL THEN
        CONTINUE;
      END IF;
      IF v_file."tenantId" <> v_user_tenant THEN
        RAISE EXCEPTION 'ECO references a file from another tenant — refusing'
          USING ERRCODE = '22023';
      END IF;

      IF v_file."lifecycleState" = 'WIP' AND NOT v_file."isCheckedOut" THEN
        UPDATE "files"
          SET "lifecycleState" = 'Released',
              "isFrozen" = TRUE,
              "updatedAt" = v_now
          WHERE "id" = v_file."id";
        v_files_transitioned := v_files_transitioned + 1;
      END IF;

      UPDATE "file_versions"
        SET "ecoId" = p_eco_id
        WHERE "fileId" = v_file."id"
          AND "version" = v_file."currentVersion"
          AND "ecoId" IS NULL
        RETURNING "id" INTO v_version_id;
      IF v_version_id IS NOT NULL THEN
        v_files_stamped := v_files_stamped + 1;
      END IF;

      INSERT INTO "audit_logs" ("id", "tenantId", "userId", "action", "entityType", "entityId", "details", "createdAt")
      VALUES (
        gen_random_uuid()::text,
        v_user_tenant,
        p_user_id,
        'file.eco_implemented',
        'file',
        v_file."id",
        jsonb_build_object(
          'name', v_file."name",
          'revision', v_file."revision",
          'version', v_file."currentVersion",
          'ecoId', p_eco_id,
          'ecoNumber', v_eco."ecoNumber",
          'transitioned', v_file."lifecycleState" = 'WIP' AND NOT v_file."isCheckedOut"
        ),
        v_now
      );
    END IF;
  END LOOP;

  -- Finalize the ECO.
  UPDATE "ecos"
    SET "status" = 'IMPLEMENTED',
        "implementedAt" = v_now,
        "implementedById" = p_user_id,
        "updatedAt" = v_now
    WHERE "id" = p_eco_id;

  INSERT INTO "audit_logs" ("id", "tenantId", "userId", "action", "entityType", "entityId", "details", "createdAt")
  VALUES (
    gen_random_uuid()::text,
    v_user_tenant,
    p_user_id,
    'eco.implemented',
    'eco',
    p_eco_id,
    jsonb_build_object(
      'ecoNumber', v_eco."ecoNumber",
      'partsReleased', v_parts_released,
      'bomsReleased', v_boms_released,
      'bomsAlreadyReleased', v_boms_already,
      'filesTransitioned', v_files_transitioned,
      'filesStamped', v_files_stamped
    ),
    v_now
  );

  -- Same keys as migration 049, so existing callers keep working unchanged.
  RETURN jsonb_build_object(
    'success', true,
    'ecoId', p_eco_id,
    'ecoNumber', v_eco."ecoNumber",
    'partsReleased', v_parts_released,
    'bomsReleased', v_boms_released,
    'bomsAlreadyReleased', v_boms_already,
    'filesTransitioned', v_files_transitioned,
    'filesStamped', v_files_stamped,
    'implementedAt', v_now
  );
END;
$$;

GRANT EXECUTE ON FUNCTION implement_eco(TEXT, TEXT) TO service_role;

-- PostgREST caches the schema. Without this the app can get
-- "PGRST202 — function does not exist" for a function that is genuinely
-- there. See docs/plans/codebase-hardening.md.
NOTIFY pgrst, 'reload schema';
