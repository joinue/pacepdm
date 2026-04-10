-- PACE PDM Migration 011: ECO ↔ File traceability + atomic ECO implementation
--
-- Today, when an ECO is marked IMPLEMENTED, the system updates `ecos.status`
-- and nothing else. The files listed in `eco_items` are not touched, and
-- there is no way — given a file at revision B — to answer "which ECO
-- caused this revision?" That gap matters for CAPA, recall, and audit.
--
-- This migration adds three things:
--
--   1. `ecos.implementedAt` / `implementedById` — records when an ECO was
--      implemented and by whom. Nullable so existing rows are unaffected.
--
--   2. `file_versions.ecoId` — nullable FK to ecos. When an ECO implements
--      a file, the file's then-current `file_versions` row is stamped with
--      the ECO id. This gives every released revision a "released by ECO"
--      marker that's visible in the version history.
--
--   3. A PL/pgSQL function `implement_eco(p_eco_id, p_user_id)` that runs
--      the entire implementation in one Postgres transaction:
--        - validates the ECO is APPROVED and tenant-owned by the caller
--        - for each linked file, transitions WIP→Released, stamps the
--          current FileVersion with `ecoId`, inserts an audit log row
--        - sets the ECO to IMPLEMENTED with timestamp + user
--      The Next.js route handler is a thin wrapper around this function.
--      This is the workaround for the Supabase JS client's lack of
--      transactions: critical multi-row writes get pushed into an RPC.
--
-- Per project convention, run this in the Supabase SQL Editor (not
-- `prisma migrate`). All statements are idempotent — safe to re-run.

-- ─── 1. ecos: implementation metadata ─────────────────────────────────────

ALTER TABLE "ecos" ADD COLUMN IF NOT EXISTS "implementedAt" TIMESTAMP(3);
ALTER TABLE "ecos" ADD COLUMN IF NOT EXISTS "implementedById" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'ecos_implementedById_fkey'
      AND table_name = 'ecos'
  ) THEN
    ALTER TABLE "ecos"
      ADD CONSTRAINT "ecos_implementedById_fkey"
      FOREIGN KEY ("implementedById") REFERENCES "tenant_users"("id")
      ON DELETE SET NULL;
  END IF;
END $$;

-- ─── 2. file_versions: ecoId stamp ────────────────────────────────────────

ALTER TABLE "file_versions" ADD COLUMN IF NOT EXISTS "ecoId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'file_versions_ecoId_fkey'
      AND table_name = 'file_versions'
  ) THEN
    ALTER TABLE "file_versions"
      ADD CONSTRAINT "file_versions_ecoId_fkey"
      FOREIGN KEY ("ecoId") REFERENCES "ecos"("id")
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "file_versions_ecoId_idx" ON "file_versions" ("ecoId");

-- ─── 3. implement_eco RPC ─────────────────────────────────────────────────
--
-- Wraps the entire ECO implementation in a single transaction. Returns a
-- jsonb summary on success; raises on validation failure so the caller's
-- supabase.rpc() call surfaces an error instead of a malformed result.
--
-- Caller responsibilities (still in the route handler, not here):
--   - auth: verify the caller is a member of the ECO's tenant
--   - permission: verify ECO_EDIT (or equivalent)
--   - notification: notify watchers after the RPC returns
--
-- Function responsibilities (here):
--   - all data validation that depends on row state
--   - all writes (ecos update, files update, file_versions update, audit)
--   - atomicity via the implicit function-scoped transaction

CREATE OR REPLACE FUNCTION implement_eco(p_eco_id TEXT, p_user_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_eco RECORD;
  v_user_tenant TEXT;
  v_item RECORD;
  v_file RECORD;
  v_version_id TEXT;
  v_files_transitioned INT := 0;
  v_files_stamped INT := 0;
  v_now TIMESTAMP(3) := CURRENT_TIMESTAMP;
BEGIN
  -- Resolve caller's tenant. The route handler already authenticated the
  -- user, but we re-check tenant ownership inside the transaction to keep
  -- the function safe even if it's called from elsewhere later.
  SELECT "tenantId" INTO v_user_tenant FROM "tenant_users" WHERE "id" = p_user_id;
  IF v_user_tenant IS NULL THEN
    RAISE EXCEPTION 'Unknown user %', p_user_id USING ERRCODE = '22023';
  END IF;

  -- Lock the ECO row to prevent concurrent implementations from racing.
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

  -- Walk every file linked to this ECO. For each:
  --   - if file is in WIP: transition to Released, mark frozen
  --   - if file is in Released: leave state alone (ECO is just confirming
  --     the release of an already-released file — uncommon but legal)
  --   - if file is anywhere else (Obsolete, etc.): skip the state change
  --     but still stamp the version with ecoId for traceability
  -- In all cases, stamp the current FileVersion row with this ecoId so
  -- the file's history shows "v3 (rev B) — released by ECO-0042".
  FOR v_item IN
    SELECT "fileId" FROM "eco_items" WHERE "ecoId" = p_eco_id
  LOOP
    SELECT * INTO v_file FROM "files" WHERE "id" = v_item."fileId" FOR UPDATE;
    IF v_file IS NULL THEN
      CONTINUE; -- File was deleted after ECO was created; skip silently
    END IF;
    IF v_file."tenantId" <> v_user_tenant THEN
      RAISE EXCEPTION 'ECO references a file from another tenant — refusing'
        USING ERRCODE = '22023';
    END IF;

    -- WIP → Released transition (the common case)
    IF v_file."lifecycleState" = 'WIP' AND NOT v_file."isCheckedOut" THEN
      UPDATE "files"
        SET "lifecycleState" = 'Released',
            "isFrozen" = TRUE,
            "updatedAt" = v_now
        WHERE "id" = v_file."id";
      v_files_transitioned := v_files_transitioned + 1;
    END IF;

    -- Stamp the current version with ecoId. We update the row matching
    -- (fileId, version=currentVersion) — that's the version this ECO
    -- effectively released. Only stamp if not already stamped, so re-
    -- running the function on a partially-completed implementation is
    -- a no-op for already-handled rows.
    UPDATE "file_versions"
      SET "ecoId" = p_eco_id
      WHERE "fileId" = v_file."id"
        AND "version" = v_file."currentVersion"
        AND "ecoId" IS NULL
      RETURNING "id" INTO v_version_id;

    IF v_version_id IS NOT NULL THEN
      v_files_stamped := v_files_stamped + 1;
    END IF;

    -- Audit row per file — same transaction, so it can never drift from
    -- the actual file state change.
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
  END LOOP;

  -- Finalize the ECO. This is the last write — if anything above raised,
  -- this never runs and the entire transaction rolls back.
  UPDATE "ecos"
    SET "status" = 'IMPLEMENTED',
        "implementedAt" = v_now,
        "implementedById" = p_user_id,
        "updatedAt" = v_now
    WHERE "id" = p_eco_id;

  -- ECO-level audit row
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
      'filesTransitioned', v_files_transitioned,
      'filesStamped', v_files_stamped
    ),
    v_now
  );

  RETURN jsonb_build_object(
    'success', true,
    'ecoId', p_eco_id,
    'ecoNumber', v_eco."ecoNumber",
    'filesTransitioned', v_files_transitioned,
    'filesStamped', v_files_stamped,
    'implementedAt', v_now
  );
END $$;

-- Allow the Supabase service role (used by Next.js route handlers via the
-- service client) to call this function. Authenticated end-users do not
-- call it directly; they go through the API.
GRANT EXECUTE ON FUNCTION implement_eco(TEXT, TEXT) TO service_role;
