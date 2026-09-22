-- PACE PDM Migration 062: create the two sales roles, loudly
--
-- Migration 059 was meant to seed "Sales" and "Sales Manager" into this
-- workspace and did not. Its guard reads:
--
--   IF (SELECT count(*) FROM "tenants") <> 1 THEN
--     RAISE NOTICE '... No roles created.';
--
-- A NOTICE in the Supabase SQL editor is a grey line under a green
-- "Success" — so with more than one tenant in the database (the E2E test
-- workspace is one), 059 reported success and created nothing. That is the
-- real bug: a migration that decides to do nothing must say so in a way that
-- stops the person running it, which is what RAISE EXCEPTION does.
--
-- ── Which workspace ─────────────────────────────────────────────────────
--
-- Run this first to see what is there:
--
--   select t.id, t.name, count(u.id) as users
--     from tenants t left join tenant_users u on u."tenantId" = t.id
--    group by t.id, t.name order by users desc;
--
-- Then set `target_name` below to the workspace's name, exactly as it
-- appears. Leave it NULL only if there is genuinely one tenant.
--
-- ── The roles ───────────────────────────────────────────────────────────
--
--   Sales          — file.view, leadtime.flag
--   Sales Manager  — file.view, leadtime.flag, leadtime.note
--
-- Read-only everywhere else, which is what `file.view` alone means. Sales can
-- ask for a lead time to be confirmed; a sales manager also writes the note
-- beside it. Both are `isSystem = false`, so the Roles page can edit or
-- delete them like any role this workspace made itself.
--
-- Idempotent: guarded on (tenantId, name), so a role that already exists — or
-- one you have since edited — is left exactly as it is. Safe to re-run after
-- fixing the name.

DO $$
DECLARE
  -- ↓↓↓ SET THIS to the workspace name from the query above ↓↓↓
  target_name TEXT := NULL;
  target_id   TEXT;
  tenant_count INT;
  created      INT;
BEGIN
  SELECT count(*) INTO tenant_count FROM "tenants";

  IF target_name IS NULL THEN
    IF tenant_count <> 1 THEN
      RAISE EXCEPTION
        'This database has % tenants, so which one gets the sales roles is not obvious. Set target_name at the top of this migration and run it again.',
        tenant_count;
    END IF;
    SELECT id INTO target_id FROM "tenants";
  ELSE
    SELECT id INTO target_id FROM "tenants" WHERE name = target_name;
    IF target_id IS NULL THEN
      RAISE EXCEPTION 'No tenant is named %. Check the name against the query at the top.', target_name;
    END IF;
  END IF;

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

  GET DIAGNOSTICS created = ROW_COUNT;
  RAISE NOTICE 'Sales roles: % created in tenant % (0 means both already existed).', created, target_id;
END $$;

-- ── Verification ────────────────────────────────────────────────────────
--
--   select r.name, t.name as workspace, r.permissions, r."isSystem"
--     from roles r join tenants t on t.id = r."tenantId"
--    where r.name in ('Sales', 'Sales Manager');
--
-- Both should be listed, against the workspace you meant, with isSystem false.
-- They then appear on the Roles admin page and can be assigned in Users.
