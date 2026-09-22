-- PACE PDM Migration 063: the sales roles, in every workspace in THIS database
--
-- Third attempt, and the last: 059 skipped silently, 062 refused to guess
-- which of two tenants should get the roles. Both were solving a problem
-- nobody has. This database holds one real workspace and the E2E test
-- workspace — both belong to the same owner — so the roles go in both, and
-- nobody has to identify a tenant by name.
--
-- This is still not "a universal role for all tenants": the roles are absent
-- from DEFAULT_ROLES (src/lib/permissions.ts), so no other deployment and no
-- workspace created from here on gets them. A migration is applied to one
-- database by hand; its reach is that database.
--
-- If the copies in the test workspace are unwanted, they delete like any
-- custom role, from the Roles page or:
--
--   delete from roles where name in ('Sales','Sales Manager') and "tenantId" = '<test tenant id>';
--
-- ── The roles ───────────────────────────────────────────────────────────
--
--   Sales          — file.view, leadtime.flag
--   Sales Manager  — file.view, leadtime.flag, leadtime.note
--
-- Read-only everywhere else, which is what `file.view` alone means. Sales can
-- ask for a machine's lead time to be confirmed; a sales manager also writes
-- the note beside it. Both are `isSystem = false`, so the Roles page can edit
-- or delete them like any role a workspace made itself.
--
-- Idempotent: guarded on (tenantId, name), so re-running changes nothing and
-- a role already edited is left as it is. Safe to run after 059 or 062,
-- whether or not either did anything.

DO $$
DECLARE
  created INT;
BEGIN
  INSERT INTO "roles" ("id", "tenantId", "name", "description", "permissions", "isSystem", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, t."id", v.name, v.description, v.permissions::jsonb, FALSE, now(), now()
  FROM "tenants" t
  CROSS JOIN (VALUES
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
    SELECT 1 FROM "roles" r WHERE r."tenantId" = t."id" AND r."name" = v.name
  );

  GET DIAGNOSTICS created = ROW_COUNT;
  RAISE NOTICE 'Sales roles: % row(s) created across % tenant(s).',
    created, (SELECT count(*) FROM "tenants");
END $$;

-- ── Verification ────────────────────────────────────────────────────────
--
--   select t.name as workspace, r.name as role, r.permissions, r."isSystem"
--     from roles r join tenants t on t.id = r."tenantId"
--    where r.name in ('Sales', 'Sales Manager')
--    order by 1, 2;
--
-- Expect two rows per workspace, isSystem false. They then appear on the
-- Roles admin page and can be assigned to people in Users.
