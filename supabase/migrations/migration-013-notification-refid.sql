-- PACE PDM Migration 013: Notification refId
--
-- Adds an optional `refId` column to notifications so a notification can
-- be tied back to the entity it was generated for (e.g. an approval
-- request id). This lets us auto-mark approval notifications as read
-- when the user handles the underlying decision before they ever open
-- the notification.
--
-- Per project convention, run this in the Supabase SQL Editor (not
-- `prisma migrate`). All statements are idempotent — safe to re-run.

ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "refId" TEXT;

CREATE INDEX IF NOT EXISTS "notifications_tenant_user_ref_idx"
  ON "notifications" ("tenantId", "userId", "refId");
