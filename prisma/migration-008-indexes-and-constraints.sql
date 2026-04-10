-- PACE PDM Migration 008: Missing Indexes and FK Constraint Fix
--
-- Adds indexes on hot-query columns flagged by the audit, and fixes the
-- TenantUser → Role foreign key so deleting a role cannot orphan users.
--
-- Run this in the Supabase SQL Editor (per the project convention of using
-- raw SQL rather than `prisma migrate`).
--
-- All statements are idempotent and tolerant of missing tables — if a table
-- doesn't exist on this instance yet, the relevant index is skipped silently
-- so the rest of the migration still runs.

-- ─── Indexes for reverse lookups and join performance ──────────────────────

DO $$
BEGIN
  -- metadata_values are looked up by file when rendering the file detail panel
  IF to_regclass('public.metadata_values') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS "metadata_values_fileId_idx"
      ON "metadata_values" ("fileId");
  ELSE
    RAISE NOTICE 'Skipping metadata_values index — table does not exist';
  END IF;

  -- approval_group_members: "find all groups this user belongs to" runs on
  -- every approval workflow evaluation
  IF to_regclass('public.approval_group_members') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS "approval_group_members_userId_idx"
      ON "approval_group_members" ("userId");
  ELSE
    RAISE NOTICE 'Skipping approval_group_members index — table does not exist';
  END IF;

  -- approval_workflow_assignments: composite (tenant, transition) for
  -- workflow lookup on file transitions
  IF to_regclass('public.approval_workflow_assignments') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS "approval_workflow_assignments_tenantId_transitionId_idx"
      ON "approval_workflow_assignments" ("tenantId", "transitionId");
  ELSE
    RAISE NOTICE 'Skipping approval_workflow_assignments index — table does not exist';
  END IF;
END $$;

-- ─── FK constraint fix ─────────────────────────────────────────────────────
-- Currently TenantUser.roleId → Role has NO ON DELETE rule, so deleting a
-- role would either fail with a vague constraint error or orphan rows
-- (depending on how the FK was created). Switch to ON DELETE RESTRICT
-- so the database refuses the delete cleanly with a clear error, and the
-- application layer must reassign users first.

DO $$
BEGIN
  IF to_regclass('public.tenant_users') IS NULL THEN
    RAISE NOTICE 'Skipping tenant_users FK fix — table does not exist';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'tenant_users_roleId_fkey'
      AND table_name = 'tenant_users'
  ) THEN
    ALTER TABLE "tenant_users" DROP CONSTRAINT "tenant_users_roleId_fkey";
  END IF;

  ALTER TABLE "tenant_users"
    ADD CONSTRAINT "tenant_users_roleId_fkey"
    FOREIGN KEY ("roleId") REFERENCES "roles"("id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE;
END $$;
