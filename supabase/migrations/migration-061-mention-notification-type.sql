-- PACE PDM Migration 061: a 'mention' notification type
--
-- Being @mentioned in a comment was filed under 'system', the one type whose
-- email is off by default and whose profile label reads "Low-priority
-- announcements". So the notification most likely to be about the reader
-- personally never reached their inbox unless they had opted into
-- announcements. It gets a type of its own, on by default
-- (src/lib/notification-types.ts), and the emitter (src/lib/mentions.ts)
-- writes it as of this migration — so this has to be applied first, or every
-- mention insert fails the CHECK and is logged and dropped.
--
-- Rows already written as 'system' are left alone; they were read as
-- mentions in the UI and still are.
--
-- Re-creates the CHECK from migration 028 / 058 / 060 with the new value.
-- Idempotent. Applied to the live database 2026-09-23.

ALTER TABLE "notifications"
  DROP CONSTRAINT IF EXISTS "notifications_type_check";

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_type_check"
  CHECK ("type" IN ('approval','transition','checkout','eco','system','leadtime','changelog','mention'));

-- ── Verification ────────────────────────────────────────────────────────
--
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'notifications_type_check';
--   -- expect: ... 'changelog', 'mention' ...
