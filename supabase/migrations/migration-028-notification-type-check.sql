-- PACE PDM Migration 028: notifications.type CHECK constraint
--
-- The notifications.type column is used by the header bell and the
-- sidebar badges to pick a color-coded pill variant. Until now the
-- column was an unconstrained `text`, so a typo in any emitter (e.g.
-- `type: "aproval"`) would silently ship a notification that the UI
-- renders with the default "muted" gray badge — visible only as a
-- mild inconsistency to the end user.
--
-- Lock the enum at the DB level so emitter typos fail loudly instead
-- of silently degrading the UI. If we need a new type in the future,
-- add it here first, then ship the emitter.
--
-- Per project convention, run in the Supabase SQL Editor. Idempotent
-- via DROP IF EXISTS + ADD.

ALTER TABLE "notifications"
  DROP CONSTRAINT IF EXISTS "notifications_type_check";

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_type_check"
  CHECK ("type" IN ('approval','transition','checkout','eco','system'));
