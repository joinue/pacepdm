-- PACE PDM Migration 017: ECO items link to parts OR files (not just files)
--
-- Today `eco_items` only has `fileId`, which contradicts the rest of the
-- schema where `parts` is "the central object in the PDM" (see migration
-- 005). A real PDM change affects a part — the part's drawings, models,
-- and specs travel together through revisions — so the natural ECO link
-- is part-level, with file-level still available for loose documents.
--
-- This migration:
--
--   1. Makes `eco_items.fileId` nullable and adds `eco_items.partId`,
--      with a CHECK constraint that exactly one of the two is set. Each
--      row is therefore either a part-level change or a file-level
--      change, never both and never neither.
--
--   2. Adds `eco_items.fromRevision` / `toRevision` (TEXT, nullable) so
--      the ECO can record "Part PRT-00042: A → B". When `toRevision` is
--      omitted on a part item, the implement step auto-bumps the letter
--      (A→B, B→C). File items ignore these fields.
--
--   3. Adds a partial unique index preventing the same part from being
--      added twice to one ECO (mirrors the existing de-dup on fileId).
--
--   4. Rewrites `implement_eco` to also walk part items: lock the part,
--      update `revision`/`lifecycleState`, stamp every current
--      file_version row for files linked via `part_files` with the ECO
--      id, and emit a part-level audit row. File items behave exactly
--      as before.
--
-- Per project convention, run this in the Supabase SQL Editor (not
-- `prisma migrate`). All statements are idempotent — safe to re-run.

-- ─── 1. eco_items: part support ──────────────────────────────────────────

ALTER TABLE "eco_items" ALTER COLUMN "fileId" DROP NOT NULL;
ALTER TABLE "eco_items" ADD COLUMN IF NOT EXISTS "partId" TEXT;
ALTER TABLE "eco_items" ADD COLUMN IF NOT EXISTS "fromRevision" TEXT;
ALTER TABLE "eco_items" ADD COLUMN IF NOT EXISTS "toRevision" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'eco_items_partId_fkey'
      AND table_name = 'eco_items'
  ) THEN
    ALTER TABLE "eco_items"
      ADD CONSTRAINT "eco_items_partId_fkey"
      FOREIGN KEY ("partId") REFERENCES "parts"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- Exactly one of (partId, fileId) must be set — XOR.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'eco_items_target_xor'
      AND table_name = 'eco_items'
  ) THEN
    ALTER TABLE "eco_items"
      ADD CONSTRAINT "eco_items_target_xor"
      CHECK (("partId" IS NULL) <> ("fileId" IS NULL));
  END IF;
END $$;

-- Prevent adding the same part twice to the same ECO.
CREATE UNIQUE INDEX IF NOT EXISTS "eco_items_ecoId_partId_key"
  ON "eco_items" ("ecoId", "partId")
  WHERE "partId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "eco_items_partId_idx" ON "eco_items" ("partId");

-- ─── 2. implement_eco: walk part items + file items ─────────────────────
--
-- The function replaces the migration-011 version. Contract is identical
-- on the outside (same name, same args, same jsonb return shape with
-- added `partsReleased` counter) so the Next.js route handler needs no
-- changes beyond surfacing the new counter.
--
-- Revision bump rule for part items:
--   - If the eco_item has a `toRevision`, use it literally.
--   - Otherwise, if the part's current revision is a single A-Z letter,
--     increment it (A→B, Y→Z). Z is the hard cap — the caller must
--     supply `toRevision` explicitly to go beyond (AA/BA/etc. vary by
--     org convention and shouldn't be invented by the server).
--   - Otherwise raise — the server won't guess.

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
  v_pf RECORD;
  v_version_id TEXT;
  v_next_rev TEXT;
  v_files_transitioned INT := 0;
  v_files_stamped INT := 0;
  v_parts_released INT := 0;
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

  -- Walk every item linked to this ECO. Each row is either a part item
  -- (partId set) or a file item (fileId set) — the XOR CHECK constraint
  -- guarantees exactly one is populated.
  FOR v_item IN
    SELECT "id", "partId", "fileId", "toRevision"
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

      -- Decide the next revision.
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

      -- Record what we actually bumped to, so the ECO history tab shows
      -- the concrete transition (A → B) even when the caller omitted
      -- toRevision and relied on the auto-bump rule.
      UPDATE "eco_items"
        SET "fromRevision" = COALESCE("fromRevision", v_part."revision"),
            "toRevision"   = v_next_rev
        WHERE "id" = v_item."id";

      -- Cascade: every file linked to this part via part_files gets its
      -- current file_versions row stamped with the ECO id. Files still
      -- in WIP (and not checked out) also transition to Released, same
      -- as file items.
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

    -- ─── File item: unchanged behavior from migration 011 ────────────
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
      'filesTransitioned', v_files_transitioned,
      'filesStamped', v_files_stamped
    ),
    v_now
  );

  RETURN jsonb_build_object(
    'success', true,
    'ecoId', p_eco_id,
    'ecoNumber', v_eco."ecoNumber",
    'partsReleased', v_parts_released,
    'filesTransitioned', v_files_transitioned,
    'filesStamped', v_files_stamped,
    'implementedAt', v_now
  );
END $$;

GRANT EXECUTE ON FUNCTION implement_eco(TEXT, TEXT) TO service_role;
