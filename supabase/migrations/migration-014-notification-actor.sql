-- PACE PDM Migration 014: Notification actor attribution
--
-- Adds an optional `actorId` column to notifications so the UI can render
-- "X approved your request" with an avatar and track who triggered a
-- notification. System-generated notifications (cron, RPCs, backfills)
-- leave this NULL — the UI falls back to the existing title/message.
--
-- Per project convention, run this in the Supabase SQL Editor (not
-- `prisma migrate`). All statements are idempotent — safe to re-run.

ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "actorId" TEXT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'notifications_actorId_fkey' AND table_name = 'notifications'
  ) THEN
    ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actorId_fkey"
      FOREIGN KEY ("actorId") REFERENCES "tenant_users"("id") ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "notifications_actor_idx"
  ON "notifications" ("tenantId", "actorId");
