-- PACE PDM Migration 058: lead-time notifications, and a live lead-time page
--
-- Two small things the lead-time page needs, both of which have to happen in
-- the database before the app can use them.
--
-- ── 1. A 'leadtime' notification type ───────────────────────────────────
--
-- Migration 028 locked `notifications.type` to five values so an emitter
-- typo fails loudly instead of rendering a grey pill, and said: add the new
-- type here first, then ship the emitter. This is that. Sales asked to hear
-- when a lead time changes, and a type of its own is what lets someone turn
-- those emails off without also turning off everything filed under 'system'
-- (src/lib/email/send.ts holds the per-user preference).
--
-- ── 2. Realtime on equipment_lead_times ─────────────────────────────────
--
-- The page subscribes to the table so a lead time someone else sets appears
-- without a refresh — sales tends to leave it open while quoting. Postgres
-- only publishes changes for tables in the `supabase_realtime` publication,
-- and a subscription to a table outside it succeeds and then silently never
-- fires, which is the failure mode worth avoiding.
--
-- Wrapped in a DO block that checks pg_publication_tables, because
-- ALTER PUBLICATION ... ADD TABLE has no IF NOT EXISTS and errors on a
-- second run. It also does nothing if the publication itself is absent
-- (a self-hosted database without Supabase Realtime) rather than failing
-- the whole script.
--
-- No policy change: the page reads through the app's service role, and RLS
-- on the table stays deny-all. Realtime respects RLS, so a browser
-- subscribed with the anon key is told a row changed, not what it holds; the
-- page refetches through the API, which does the tenant scoping.
--
-- Idempotent. Not verified against the live database.

-- ── 1. The notification type ────────────────────────────────────────────

ALTER TABLE "notifications"
  DROP CONSTRAINT IF EXISTS "notifications_type_check";

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_type_check"
  CHECK ("type" IN ('approval','transition','checkout','eco','system','leadtime'));

-- ── 2. Realtime ─────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'equipment_lead_times'
     )
  THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE "equipment_lead_times";
  END IF;
END $$;

-- ── Verification ────────────────────────────────────────────────────────
--
--   -- the new type is allowed:
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'notifications_type_check';
--
--   -- the page will receive changes:
--   select tablename from pg_publication_tables
--    where pubname = 'supabase_realtime' and schemaname = 'public'
--    order by 1;
