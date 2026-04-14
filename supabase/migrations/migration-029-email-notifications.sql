-- PACE PDM Migration 029: email notifications + approval reminders
--
-- Adds the minimum schema needed to send transactional email for
-- in-app notifications and to dedupe approval-deadline reminders sent
-- by the Vercel Cron job at /api/cron/approval-reminders.
--
-- Tenant email settings (from-name, reply-to, reminders on/off) live
-- in the existing `tenants.settings` jsonb column — no new table.
--
-- Per project convention, run in the Supabase SQL Editor. Idempotent.

-- 1) Per-notification delivery tracking. Lets us surface "email failed"
--    in the bell UI and avoid re-sending on retries.
ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "emailSentAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "emailError" text;

-- 2) Per-user email preferences. Defaults to "everything on" so new
--    users get the same behavior as the in-app bell.
ALTER TABLE "tenant_users"
  ADD COLUMN IF NOT EXISTS "emailPrefs" jsonb NOT NULL DEFAULT
    '{"approval":true,"transition":true,"checkout":true,"eco":true,"system":false}'::jsonb;

-- 3) Approval reminder dedup. The cron sweeps every 30 minutes; we
--    must never send the same reminder twice. Key is (decisionId, kind)
--    so we can later add more thresholds (e.g. "approaching") without
--    another migration.
CREATE TABLE IF NOT EXISTS "approval_reminders" (
  "decisionId" text NOT NULL,
  "kind" text NOT NULL,
  "sentAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("decisionId", "kind"),
  CONSTRAINT "approval_reminders_decisionId_fkey"
    FOREIGN KEY ("decisionId") REFERENCES "approval_decisions"("id") ON DELETE CASCADE,
  CONSTRAINT "approval_reminders_kind_check"
    CHECK ("kind" IN ('overdue'))
);

CREATE INDEX IF NOT EXISTS "approval_decisions_pending_deadline_idx"
  ON "approval_decisions" ("deadlineAt")
  WHERE "status" = 'PENDING' AND "deadlineAt" IS NOT NULL;
