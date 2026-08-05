-- PACE PDM Migration 047: seed the Manager system role into existing tenants
--
-- `DEFAULT_ROLES` in src/lib/permissions.ts only runs at tenant creation
-- (src/app/api/tenants/route.ts). Adding a fourth default role there gives it
-- to every workspace signed up from now on and to nobody who already exists,
-- so the constant and the database disagree until this runs.
--
-- ── Why the role exists ─────────────────────────────────────────────────
--
-- The seeded ladder was Admin ("*") → Engineer → Viewer, which is read → do
-- → own the tenant with nothing in between. Five declared permissions were
-- held by no default role except through Admin's wildcard:
--
--   file.delete, folder.delete, folder.manage_access, audit.view, eco.approve
--
-- So on a fresh workspace, deleting a superseded drawing, setting up folder
-- access, or answering an auditor all required a role that ALSO grants role
-- authoring, SSO configuration, tenant settings, and folder.bypass_access.
-- Manager is Engineer plus exactly those five, plus admin.users.
--
-- admin.users is the only one worth arguing about, and it is bounded:
-- src/app/api/users/[userId]/route.ts runs `permissionsExceedingActor` on
-- role assignment, so a Manager can invite and deactivate people but cannot
-- promote anyone — themselves included — to a role stronger than Manager.
--
-- Deliberately NOT granted: admin.roles, admin.settings, admin.lifecycle,
-- admin.metadata, folder.bypass_access, and "*". A Manager runs the team;
-- an Admin runs the tenant.
--
-- ── isSystem ────────────────────────────────────────────────────────────
--
-- Seeded with "isSystem" = true to match Admin/Engineer/Viewer. That makes
-- it uneditable and undeletable (src/app/api/roles/[roleId]/route.ts blocks
-- both), which is the point: a tenant that wants a different cut can create
-- a custom role, and the shipped one keeps a stable meaning across tenants.
--
-- ── Re-runnable ─────────────────────────────────────────────────────────
--
-- The insert is guarded by NOT EXISTS on (tenantId, name), so pasting this
-- twice is a no-op. It matches on the name only, so a tenant that already
-- hand-rolled a role called "Manager" keeps theirs untouched rather than
-- getting a duplicate or having their permission set overwritten.
--
-- No user is reassigned. Promoting someone to Manager is a decision a person
-- makes, and every existing user keeps the role they have.

INSERT INTO "roles" ("id", "tenantId", "name", "description", "permissions", "isSystem", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  t."id",
  'Manager',
  'Approve changes, manage team access, and review the audit trail',
  '["file.view","file.upload","file.edit","file.checkout","file.checkin","file.transition","folder.create","folder.edit","eco.create","eco.edit","share.create","file.delete","folder.delete","folder.manage_access","eco.approve","audit.view","admin.users"]'::jsonb,
  TRUE,
  NOW(),
  NOW()
FROM "tenants" t
WHERE NOT EXISTS (
  SELECT 1 FROM "roles" r
   WHERE r."tenantId" = t."id"
     AND r."name" = 'Manager'
);

-- ── Verification ────────────────────────────────────────────────────────
--
--   -- every tenant has one, and only one, Manager row:
--   select count(*) filter (where mgr = 0) as missing,
--          count(*) filter (where mgr > 1) as duplicated
--     from (select t.id, count(r.id) as mgr
--             from tenants t
--             left join roles r on r."tenantId" = t.id and r.name = 'Manager'
--            group by t.id) x;
--   -- expected: missing 0, duplicated 0
--
--   -- the permission set landed as an array, not a string:
--   select jsonb_array_length(permissions) from roles where name = 'Manager' limit 1;
--   -- expected: 17
--
-- RLS: no new tables. `roles` was locked down in migration 039 and its
-- policies are unchanged.
