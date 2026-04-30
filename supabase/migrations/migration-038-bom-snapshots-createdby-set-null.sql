-- PACE PDM Migration 038: bom_snapshots.createdById → SET NULL
--
-- Migration 035 intended to relax every tenant_users-referencing FK to
-- SET NULL so an admin could hard-remove a member from a workspace.
-- The bom_snapshots fix in that migration targeted a table named
-- "bom_baselines", which never existed — the real table is
-- "bom_snapshots" (see migration-027). The DO ... IF EXISTS block
-- silently no-op'd, so bom_snapshots.createdById is still implicit
-- NO ACTION and a delete on a tenant_users row whose owner authored a
-- snapshot fails with a foreign-key violation.
--
-- This migration drops and re-adds the FK with ON DELETE SET NULL so
-- the user-removal path in /api/users/[userId] DELETE works.
--
-- Per project convention, run in the Supabase SQL Editor. Idempotent.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'bom_snapshots'
      AND constraint_name = 'bom_snapshots_createdById_fkey'
  ) THEN
    ALTER TABLE "bom_snapshots" DROP CONSTRAINT "bom_snapshots_createdById_fkey";
  END IF;

  ALTER TABLE "bom_snapshots"
    ADD CONSTRAINT "bom_snapshots_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "tenant_users"("id")
    ON DELETE SET NULL;
END $$;
