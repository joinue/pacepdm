-- PACE PDM Migration 049: ECO items can actually hold a BOM, and
--                          implementing an ECO releases the BOMs it carries
--
-- Two things, one story: the change-control loop's last open link.
--
-- ── 1. The XOR constraint never learned about bomId ─────────────────────
--
-- Migration 017 added:
--
--     CHECK (("partId" IS NULL) <> ("fileId" IS NULL))
--
-- Migration 046 then added `eco_items.bomId` — the column, the FK, the
-- index, the unique key, the picker, and `POST /api/boms/[bomId]/revise`'s
-- `ecoId` link — but left that constraint alone. For a BOM-only row both
-- sides evaluate TRUE, `TRUE <> TRUE` is FALSE, and the insert is rejected
-- with 23514.
--
-- So "an ECO can contain a BOM" has never worked at runtime. It stayed
-- invisible because the one caller that reports the failure — the revise
-- route — deliberately downgrades it to a `warning` in the response body
-- rather than throwing, on the reasoning that a bad ECO link should not
-- cost the caller the revision they just created. Good instinct; it also
-- meant a hard schema rejection read as a soft note.
--
-- Replaced with an exactly-one-of-three check. Named differently
-- (`eco_items_target_one`) because the old name says XOR and this is no
-- longer an XOR; the old constraint is dropped by name.
--
-- ── 2. implement_eco skipped BOM items entirely ─────────────────────────
--
-- The function walks part items and file items. Rows carrying a `bomId`
-- fell through both branches and were silently ignored, so an ECO could
-- *record* that a BOM goes B → C while implementing it did nothing about
-- the BOM. `toRevision` on a BOM line was documentation, not an
-- instruction, and a human still had to go and release the revision by
-- hand.
--
-- What implementing a BOM item means, and why it is a release rather than
-- a revise: `POST /api/boms/[bomId]/revise` already runs at ECO *authoring*
-- time — it creates revision C as a new DRAFT row and links that row to the
-- ECO. By the time the ECO is approved, C exists and is waiting. So
-- implementation does not need to duplicate the revise rules in PL/pgSQL
-- (which is what docs/plans/change-control.md was weighing); it needs to
-- do what releasing a BOM does:
--
--     1. status → RELEASED
--     2. the revision it came from → OBSOLETE, supersededById → this row
--
-- Step 2 mirrors PUT /api/boms/[bomId] exactly, including *why* it happens
-- on release and not on draft: until C is released, B is still the revision
-- in effect, and a draft supersedes nothing.
--
-- Status handling, and the one deliberate liberty:
--
--   DRAFT / IN_REVIEW / APPROVED → released. This crosses BOM_STATUS_FLOW,
--     which only allows APPROVED → RELEASED. That is intentional: the ECO's
--     own approval *is* the review, and forcing a BOM through a second
--     independent approval cycle to satisfy a state machine is ceremony,
--     not control. Recorded in src/lib/status-flows.ts as
--     BOM_STATES_RELEASABLE_BY_ECO so the two do not drift silently, and
--     pinned by a test.
--   RELEASED → skipped, counted in `bomsAlreadyReleased`. Makes the
--     function idempotent for a BOM that was released by hand first.
--   OBSOLETE → raises. Shipping a change whose structure is obsolete is a
--     mistake worth failing on, not a no-op worth swallowing.
--
-- The BOM baseline snapshot is NOT taken here. `createReleaseFromEco` runs
-- after this function commits and calls `captureBomSnapshot` for every BOM
-- in the release — same split as the rest of the release manifest, and the
-- same reasoning: a failure to snapshot must not roll back the
-- implementation.
--
-- Contract is unchanged on the outside: same name, same args, same jsonb
-- shape with two counters added. Re-runnable.

-- ── 1. eco_items: exactly one of partId / fileId / bomId ────────────────

ALTER TABLE "eco_items" DROP CONSTRAINT IF EXISTS "eco_items_target_xor";
ALTER TABLE "eco_items" DROP CONSTRAINT IF EXISTS "eco_items_target_one";

ALTER TABLE "eco_items"
  ADD CONSTRAINT "eco_items_target_one"
  CHECK (
    (CASE WHEN "partId" IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN "fileId" IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN "bomId"  IS NOT NULL THEN 1 ELSE 0 END) = 1
  );

-- ── 2. implement_eco: walk BOM items too ────────────────────────────────

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

      IF v_item."toRevision" IS NOT NULL AND length(trim(v_item."toRevision")) > 0 THEN
        v_next_rev := trim(v_item."toRevision");
      ELSIF v_part."revision" ~ '^[A-Y]$' THEN
        v_next_rev := chr(ascii(v_part."revision") + 1);
      ELSE
        RAISE EXCEPTION
          'Cannot auto-bump revision for part % (current rev: "%") — set toRevision explicitly',
          v_part."partNumber", v_part."revision"
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
          'transitioned', v_file."lifecycleState" = 'WIP'
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

  -- Same keys as the migration-017 shape plus the two BOM counters, so
  -- existing callers and tests keep working unchanged.
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
