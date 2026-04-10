-- PACE PDM Migration 012: Folder-level access control
--
-- Adds per-folder access control layered over the existing role-based
-- permission system. A folder with zero ACL rows remains fully public and
-- falls back to the user's global role permissions (backward compatible).
-- A folder with any row becomes "restricted": only principals matching an
-- ALLOW row can access it, and DENY always wins.
--
-- Access inherits down the tree when `inherited = true` (the default).
-- A row with `inherited = false` applies only to the folder it's attached
-- to, not its descendants.
--
-- Supports future extension via the PrincipalType enum (USER | ROLE today;
-- GROUP, API_KEY, SERVICE later) and the `expiresAt` column for time-boxed
-- access without schema churn.
--
-- Per project convention, run this in the Supabase SQL Editor (not
-- `prisma migrate`). All statements are idempotent — safe to re-run.

-- ─── 1. Enums ─────────────────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FolderAccessPrincipal') THEN
    CREATE TYPE "FolderAccessPrincipal" AS ENUM ('USER', 'ROLE');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FolderAccessLevel') THEN
    CREATE TYPE "FolderAccessLevel" AS ENUM ('VIEW', 'EDIT', 'ADMIN');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FolderAccessEffect') THEN
    CREATE TYPE "FolderAccessEffect" AS ENUM ('ALLOW', 'DENY');
  END IF;
END $$;

-- ─── 2. folder_access table ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "folder_access" (
  "id"            TEXT PRIMARY KEY,
  "tenantId"      TEXT NOT NULL,
  "folderId"      TEXT NOT NULL,
  "principalType" "FolderAccessPrincipal" NOT NULL,
  "principalId"   TEXT NOT NULL,
  "level"         "FolderAccessLevel" NOT NULL,
  "effect"        "FolderAccessEffect" NOT NULL DEFAULT 'ALLOW',
  "inherited"     BOOLEAN NOT NULL DEFAULT TRUE,
  "grantedById"   TEXT,
  "grantedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"     TIMESTAMP(3),
  "note"          TEXT
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'folder_access_tenantId_fkey' AND table_name = 'folder_access'
  ) THEN
    ALTER TABLE "folder_access" ADD CONSTRAINT "folder_access_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'folder_access_folderId_fkey' AND table_name = 'folder_access'
  ) THEN
    ALTER TABLE "folder_access" ADD CONSTRAINT "folder_access_folderId_fkey"
      FOREIGN KEY ("folderId") REFERENCES "folders"("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'folder_access_grantedById_fkey' AND table_name = 'folder_access'
  ) THEN
    ALTER TABLE "folder_access" ADD CONSTRAINT "folder_access_grantedById_fkey"
      FOREIGN KEY ("grantedById") REFERENCES "tenant_users"("id") ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "folder_access_tenant_folder_idx"
  ON "folder_access" ("tenantId", "folderId");
CREATE INDEX IF NOT EXISTS "folder_access_principal_idx"
  ON "folder_access" ("tenantId", "principalType", "principalId");

-- ─── 3. folders.isRestricted fast-path flag ───────────────────────────────
-- Denormalized flag maintained by the trigger below. Lets the UI show a
-- lock badge per folder without invoking the full resolver.

ALTER TABLE "folders" ADD COLUMN IF NOT EXISTS "isRestricted" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION update_folder_is_restricted()
RETURNS TRIGGER AS $$
DECLARE
  v_folder_id TEXT := COALESCE(NEW."folderId", OLD."folderId");
BEGIN
  UPDATE "folders"
  SET "isRestricted" = EXISTS (
    SELECT 1 FROM "folder_access" fa
    WHERE fa."folderId" = v_folder_id
      AND (fa."expiresAt" IS NULL OR fa."expiresAt" > CURRENT_TIMESTAMP)
  )
  WHERE "id" = v_folder_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS folder_access_maintain_flag ON "folder_access";
CREATE TRIGGER folder_access_maintain_flag
AFTER INSERT OR UPDATE OR DELETE ON "folder_access"
FOR EACH ROW EXECUTE FUNCTION update_folder_is_restricted();

-- ─── 4. get_folder_access_scope RPC ───────────────────────────────────────
--
-- Resolves the full set of folder IDs a user can view / edit / admin in
-- a single call. Returns JSONB so the Supabase JS client can consume it
-- directly.
--
-- Semantics:
--   - Fully public tenant (no ACL rows at all): returns empty arrays and
--     restrictedAny=false. Callers treat this as "no filtering needed".
--   - Bypass flag: returns all tenant folder IDs in all three arrays.
--     Used by support/debug roles holding FOLDER_ACCESS_BYPASS.
--   - Otherwise walks the folder tree once, aggregates ACL rows per
--     folder (self + inherited ancestors), applies DENY-wins, and
--     emits per-folder effective access.
--
-- A folder is considered "restricted" if it or any ancestor has at least
-- one non-expired ACL row applicable to it (either self or inherited).
-- Unrestricted folders are always viewable; restricted folders require
-- an explicit ALLOW at or above the requested level, with no DENY.

CREATE OR REPLACE FUNCTION get_folder_access_scope(
  p_tenant_id TEXT,
  p_user_id   TEXT,
  p_role_id   TEXT,
  p_bypass    BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_result        JSONB;
  v_any_active    BOOLEAN;
BEGIN
  -- Bypass: full tenant scope, no evaluation.
  IF p_bypass THEN
    SELECT jsonb_build_object(
      'bypass',        TRUE,
      'restrictedAny', FALSE,
      'allowed',       COALESCE(jsonb_agg("id"), '[]'::jsonb),
      'editable',      COALESCE(jsonb_agg("id"), '[]'::jsonb),
      'admin',         COALESCE(jsonb_agg("id"), '[]'::jsonb),
      'denied',        '[]'::jsonb,
      'restricted',    '[]'::jsonb
    )
    INTO v_result
    FROM "folders"
    WHERE "tenantId" = p_tenant_id;
    RETURN v_result;
  END IF;

  -- Fast path: no non-expired ACL rows in the tenant — everything is public.
  SELECT EXISTS (
    SELECT 1 FROM "folder_access"
    WHERE "tenantId" = p_tenant_id
      AND ("expiresAt" IS NULL OR "expiresAt" > CURRENT_TIMESTAMP)
  ) INTO v_any_active;

  IF NOT v_any_active THEN
    RETURN jsonb_build_object(
      'bypass',        FALSE,
      'restrictedAny', FALSE,
      'allowed',       '[]'::jsonb,
      'editable',      '[]'::jsonb,
      'admin',         '[]'::jsonb,
      'denied',        '[]'::jsonb,
      'restricted',    '[]'::jsonb
    );
  END IF;

  -- Slow path: walk the folder tree once with ancestor arrays, then join
  -- ACL rows that apply to each folder (self rows regardless of inherited,
  -- ancestor rows only if inherited = true). DENY always wins.
  WITH RECURSIVE tree AS (
    SELECT "id", "parentId", ARRAY["id"]::TEXT[] AS ancestors
    FROM "folders"
    WHERE "tenantId" = p_tenant_id AND "parentId" IS NULL
    UNION ALL
    SELECT f."id", f."parentId", t.ancestors || f."id"
    FROM "folders" f
    JOIN tree t ON f."parentId" = t."id"
    WHERE f."tenantId" = p_tenant_id
  ),
  folder_rows AS (
    SELECT
      t."id" AS folder_id,
      fa."level",
      fa."effect",
      fa."folderId" AS source_folder_id
    FROM tree t
    CROSS JOIN LATERAL unnest(t.ancestors) AS ancestor_id
    JOIN "folder_access" fa
      ON fa."folderId" = ancestor_id
     AND fa."tenantId" = p_tenant_id
    WHERE (fa."expiresAt" IS NULL OR fa."expiresAt" > CURRENT_TIMESTAMP)
      AND (ancestor_id = t."id" OR fa."inherited" = TRUE)
      AND (
        (fa."principalType" = 'USER' AND fa."principalId" = p_user_id) OR
        (fa."principalType" = 'ROLE' AND fa."principalId" = p_role_id)
      )
  ),
  per_folder AS (
    SELECT
      folder_id,
      BOOL_OR(effect = 'DENY') AS has_deny,
      MAX(CASE WHEN effect = 'ALLOW' THEN
        CASE level
          WHEN 'ADMIN' THEN 3
          WHEN 'EDIT'  THEN 2
          WHEN 'VIEW'  THEN 1
        END
      END) AS allow_level
    FROM folder_rows
    GROUP BY folder_id
  ),
  -- Per-folder "is restricted" check: true if any non-expired ACL row
  -- applies to this folder (self, or inherited from an ancestor).
  restricted_per_folder AS (
    SELECT
      t."id" AS folder_id,
      EXISTS (
        SELECT 1
        FROM "folder_access" fa
        WHERE fa."tenantId" = p_tenant_id
          AND fa."folderId" = ANY(t.ancestors)
          AND (fa."expiresAt" IS NULL OR fa."expiresAt" > CURRENT_TIMESTAMP)
          AND (fa."folderId" = t."id" OR fa."inherited" = TRUE)
      ) AS is_restricted
    FROM tree t
  ),
  resolved AS (
    SELECT
      t."id" AS folder_id,
      COALESCE(rpf.is_restricted, FALSE) AS is_restricted,
      COALESCE(pf.has_deny, FALSE) AS has_deny,
      pf.allow_level
    FROM tree t
    LEFT JOIN restricted_per_folder rpf ON rpf.folder_id = t."id"
    LEFT JOIN per_folder pf ON pf.folder_id = t."id"
  )
  SELECT jsonb_build_object(
    'bypass',        FALSE,
    'restrictedAny', TRUE,
    'allowed', COALESCE(jsonb_agg(folder_id)
      FILTER (WHERE NOT is_restricted OR (NOT has_deny AND COALESCE(allow_level, 0) >= 1)),
      '[]'::jsonb),
    'editable', COALESCE(jsonb_agg(folder_id)
      FILTER (WHERE NOT is_restricted OR (NOT has_deny AND COALESCE(allow_level, 0) >= 2)),
      '[]'::jsonb),
    'admin', COALESCE(jsonb_agg(folder_id)
      FILTER (WHERE NOT is_restricted OR (NOT has_deny AND COALESCE(allow_level, 0) >= 3)),
      '[]'::jsonb),
    'denied', COALESCE(jsonb_agg(folder_id)
      FILTER (WHERE is_restricted AND (has_deny OR allow_level IS NULL)),
      '[]'::jsonb),
    'restricted', COALESCE(jsonb_agg(folder_id) FILTER (WHERE is_restricted), '[]'::jsonb)
  ) INTO v_result
  FROM resolved;

  RETURN COALESCE(v_result, jsonb_build_object(
    'bypass',        FALSE,
    'restrictedAny', TRUE,
    'allowed',       '[]'::jsonb,
    'editable',      '[]'::jsonb,
    'admin',         '[]'::jsonb,
    'denied',        '[]'::jsonb,
    'restricted',    '[]'::jsonb
  ));
END;
$$;

GRANT EXECUTE ON FUNCTION get_folder_access_scope(TEXT, TEXT, TEXT, BOOLEAN) TO service_role;
