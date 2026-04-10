-- PACE PDM Migration 019: Approval reference integrity (top-flight PDM rules)
--
-- Approval groups and workflows are audit-trail anchors. Once a group
-- has signed off on anything — or a workflow has produced a decision —
-- the entity must remain resolvable forever, even if the org chart
-- changes. ISO 9001 / AS9100 / 21 CFR Part 11 all assume you can answer
-- "who approved this on which day, under which workflow definition" for
-- the lifetime of the record.
--
-- Two changes:
--
-- 1. Add `isActive` to `approval_groups` so the API can soft-delete
--    (archive) any group that's referenced by a workflow step or a
--    historical decision. Hard delete remains available for groups
--    that have never been used.
--
-- 2. Tighten `approval_workflow_steps.groupId` from ON DELETE CASCADE
--    to ON DELETE RESTRICT. The CASCADE meant deleting a group could
--    silently amputate workflow steps, leaving a workflow with no
--    steps and a default release transition that returned "Workflow
--    has no steps" forever. RESTRICT forces the application path
--    (which now archives instead).
--
-- `approval_decisions.groupId` already has NO ACTION (the default in
-- migration-002), so historical decisions already block hard delete at
-- the DB layer — but the application can fall through to archive
-- gracefully instead of hitting a 23503.
--
-- Run this in the Supabase SQL Editor. Idempotent.

-- ─── 1. isActive on approval_groups ───────────────────────────────────

ALTER TABLE "approval_groups"
  ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT TRUE;

-- Existing groups are already in use; default TRUE is correct, no
-- backfill query needed.

CREATE INDEX IF NOT EXISTS "approval_groups_tenantId_isActive_idx"
  ON "approval_groups" ("tenantId", "isActive");

-- ─── 2. workflow_steps.groupId: CASCADE → RESTRICT ────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'approval_workflow_steps_groupId_fkey'
      AND table_name = 'approval_workflow_steps'
  ) THEN
    ALTER TABLE "approval_workflow_steps"
      DROP CONSTRAINT "approval_workflow_steps_groupId_fkey";
  END IF;

  ALTER TABLE "approval_workflow_steps"
    ADD CONSTRAINT "approval_workflow_steps_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "approval_groups"("id")
    ON DELETE RESTRICT;
END $$;
