-- PACE PDM Migration 059: flag a lead time for review, and two sales roles
--
-- Sales can read the lead-time page but not change it, which leaves them
-- emailing engineering to ask "is six weeks still right?" — the thing this
-- page exists to stop. Flagging is that question, in the app: sales marks a
-- machine, everyone who can answer is notified, and the flag clears when the
-- lead time is set.
--
-- ── 1. The flag ─────────────────────────────────────────────────────────
--
-- Three columns on the row rather than a table of its own: a machine is
-- either waiting on an answer or it is not, and the answer is the next entry
-- in `equipment_lead_time_changes`, which is already kept. `flagReason` is
-- what sales typed, so whoever answers knows which customer is waiting.
--
-- ── 2. Two roles, for THIS workspace only ───────────────────────────────
--
-- Not in DEFAULT_ROLES, deliberately: every other tenant would get "Sales"
-- and "Sales Manager" whether or not they sell anything, and DEFAULT_ROLES
-- only runs at tenant creation anyway. These are ordinary custom roles, the
-- kind the Roles admin page creates, seeded here so nobody has to tick
-- fourteen boxes by hand:
--
--   Sales          — file.view, leadtime.flag
--   Sales Manager  — file.view, leadtime.flag, leadtime.note
--
-- Read-only everywhere else, which is what `file.view` alone means. Both are
-- `isSystem = false`, so the Roles page can edit or delete them like any role
-- this workspace made itself.
--
-- WHICH TENANT: by default this targets the only tenant in the database,
-- which is the case here. If there is more than one, it does nothing and
-- says so — set `target_name` below to the workspace name and re-run, rather
-- than seeding a role into somebody else's tenant.
--
-- Idempotent: the insert is guarded on (tenantId, name), so a role that
-- already exists — or one you have since edited — is left exactly as it is.
--
-- Not verified against the live database.

-- ── 1. Flag columns ─────────────────────────────────────────────────────

ALTER TABLE "equipment_lead_times"
  ADD COLUMN IF NOT EXISTS "flaggedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "flaggedById" text REFERENCES "tenant_users"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "flagReason" text;

-- The page's "needs attention" list reads these first.
CREATE INDEX IF NOT EXISTS "equipment_lead_times_flagged_idx"
  ON "equipment_lead_times" ("tenantId", "flaggedAt")
  WHERE "flaggedAt" IS NOT NULL;

-- ── 2. The two sales roles, in one workspace ────────────────────────────

DO $$
DECLARE
  -- Leave NULL to use the only tenant in this database; otherwise set the
  -- workspace name exactly as it appears in `tenants.name`.
  target_name TEXT := NULL;
  target_id   TEXT;
BEGIN
  IF target_name IS NULL THEN
    SELECT id INTO target_id FROM "tenants" LIMIT 2;
    IF (SELECT count(*) FROM "tenants") <> 1 THEN
      RAISE NOTICE 'More than one tenant (or none): set target_name in this migration and re-run. No roles created.';
      target_id := NULL;
    END IF;
  ELSE
    SELECT id INTO target_id FROM "tenants" WHERE name = target_name;
    IF target_id IS NULL THEN
      RAISE NOTICE 'No tenant named %. No roles created.', target_name;
    END IF;
  END IF;

  IF target_id IS NOT NULL THEN
    INSERT INTO "roles" ("id", "tenantId", "name", "description", "permissions", "isSystem", "createdAt", "updatedAt")
    SELECT gen_random_uuid()::text, target_id, v.name, v.description, v.permissions::jsonb, FALSE, now(), now()
    FROM (VALUES
      (
        'Sales',
        'Read-only, and can ask for a machine''s lead time to be confirmed',
        '["file.view","leadtime.flag"]'
      ),
      (
        'Sales Manager',
        'Read-only, can ask for a lead time to be confirmed, and writes the note beside it',
        '["file.view","leadtime.flag","leadtime.note"]'
      )
    ) AS v(name, description, permissions)
    WHERE NOT EXISTS (
      SELECT 1 FROM "roles" r WHERE r."tenantId" = target_id AND r."name" = v.name
    );
  END IF;
END $$;

-- ── Verification ────────────────────────────────────────────────────────
--
--   -- the two roles, and what they hold:
--   select name, permissions, "isSystem" from roles
--    where name in ('Sales', 'Sales Manager');
--
--   -- nothing is flagged yet:
--   select count(*) from "equipment_lead_times" where "flaggedAt" is not null;
