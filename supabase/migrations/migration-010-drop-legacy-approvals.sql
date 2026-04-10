-- PACE PDM Migration 010: Drop legacy approvals table + add hot-path indexes
--
-- The original `approvals` table (model `Approval`) and its `ApprovalStatus`
-- enum predate the workflow-based approval engine. Application code switched
-- entirely to `approval_requests` + `approval_decisions` (added in migrations
-- 002 and 006) and nothing in src/ has read or written `approvals` since.
-- Carrying both around confuses new contributors and leaves a foreign key
-- pointing at tenant_users that nobody is using.
--
-- This migration:
--   1. Drops the `approvals` table (CASCADE picks up FKs)
--   2. Drops the `ApprovalStatus` enum
--   3. Adds indexes on approval_decisions(requestId, stepId) and
--      approval_decisions(requestId, status) — both are queried per-decision
--      by the approval engine (see lib/approval-engine.ts: processDecision,
--      evaluateStepCompletion). Without these, every decision evaluation does
--      a full scan of all decisions for the request.
--
-- Per project convention, run this in the Supabase SQL Editor (not
-- `prisma migrate`). All statements are idempotent — safe to re-run.
--
-- IMPORTANT: After running this SQL, regenerate the Prisma client locally
-- (`npx prisma generate`) so src/generated/prisma stops exporting the dead
-- Approval model and ApprovalStatus enum.

-- ─── 1. Drop legacy approvals table ────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.approvals') IS NOT NULL THEN
    -- Sanity check: refuse to drop if rows exist. If somebody re-introduced
    -- writes against this table since the cutover, surface that loudly
    -- instead of silently dropping data.
    IF EXISTS (SELECT 1 FROM "approvals" LIMIT 1) THEN
      RAISE EXCEPTION 'approvals table still has rows — investigate before dropping (expected to be empty post-cutover)';
    END IF;

    DROP TABLE "approvals";
  ELSE
    RAISE NOTICE 'Skipping approvals drop — table does not exist';
  END IF;
END $$;

-- ─── 2. Drop ApprovalStatus enum ───────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ApprovalStatus') THEN
    DROP TYPE "ApprovalStatus";
  ELSE
    RAISE NOTICE 'Skipping ApprovalStatus enum drop — type does not exist';
  END IF;
END $$;

-- ─── 3. Add hot-path indexes on approval_decisions ─────────────────────────

DO $$
BEGIN
  IF to_regclass('public.approval_decisions') IS NULL THEN
    RAISE NOTICE 'Skipping approval_decisions indexes — table does not exist';
    RETURN;
  END IF;

  -- Used by step-completion evaluation: "fetch all decisions for this
  -- request belonging to the active step"
  CREATE INDEX IF NOT EXISTS "approval_decisions_requestId_stepId_idx"
    ON "approval_decisions" ("requestId", "stepId");

  -- Used by decision aggregation: "how many of this request's decisions
  -- are APPROVED / REJECTED / PENDING right now"
  CREATE INDEX IF NOT EXISTS "approval_decisions_requestId_status_idx"
    ON "approval_decisions" ("requestId", "status");
END $$;
