-- PACE PDM Migration 023: Enable RLS + SELECT policies (defense-in-depth)
--
-- Step 2 of the RLS rollout. Migration 022 added a Custom Access Token
-- hook that injects `app_metadata.tenantId` and `app_metadata.tenantUserId`
-- into every JWT. This migration turns on RLS for the tables the browser
-- touches directly (via the Supabase realtime channels added in recent
-- work) and adds SELECT policies that read those claims.
--
-- What changes, and what doesn't
-- ──────────────────────────────
--
-- Every Next.js API route in this project uses `getServiceClient()`
-- which authenticates with the service_role key, and service_role
-- bypasses RLS. So enabling RLS does NOT break any server-side read
-- or write. The policies below are defense-in-depth against two
-- specific exposures that exist today because the anon key is
-- public:
--
--   1. Browser code subscribing to `postgres_changes` channels can,
--      today, drop its tenant filter and receive every tenant's row
--      change events. After this migration, PostgREST drops those
--      events before they leave the DB.
--
--   2. Anyone with devtools can, today, grab the anon key out of the
--      JS bundle and run arbitrary SELECTs against any table. After
--      this migration, those SELECTs return only the caller's own
--      tenant (or nothing, for a caller with no JWT claim).
--
-- Scope: SELECT policies only
-- ───────────────────────────
--
-- INSERT / UPDATE / DELETE policies are deliberately NOT added in
-- this migration. All writes still go through server routes using
-- service_role, which bypasses RLS. Adding write policies is
-- straightforward later (migration 024 — `FOR INSERT WITH CHECK`
-- mirroring each USING clause), but doing it now would require
-- carefully verifying every mutation in every route against the
-- policy shape, and one mistake causes silent drops of legitimate
-- writes. SELECT-only is the smaller, less risky bite.
--
-- Tables covered
-- ──────────────
--
-- Direct `tenantId` column — the simple case:
--   files, folders, ecos, parts, boms, approval_requests
--
-- Parent-scoped (no `tenantId` column, joined via FK):
--   file_versions  → files.tenantId       via "fileId"
--   eco_items      → ecos.tenantId        via "ecoId"
--   bom_items      → boms.tenantId        via "bomId"
--   approval_decisions → approval_requests.tenantId via "requestId"
--
-- Per-user:
--   notifications  → "userId" = tenantUserId claim (each user only
--                    sees their own notifications, not every
--                    notification in their tenant)
--
-- Tables deliberately NOT in this migration
-- ─────────────────────────────────────────
--
-- tenant_users, roles, tenants, metadata_fields, vendors, part_vendors,
-- part_files, lifecycles, lifecycle_transitions, approval_groups,
-- approval_group_members, approval_workflows, approval_workflow_steps,
-- approval_workflow_assignments, audit_logs, etc.
--
-- The browser never queries these directly today. If a future feature
-- subscribes them, add RLS and policies in the same PR that introduces
-- the subscription — don't front-run it here, because the policy shape
-- depends on exactly what the feature needs to see.
--
-- Permissive mode, not FORCE
-- ──────────────────────────
--
-- `ENABLE ROW LEVEL SECURITY` (permissive) lets the table owner and
-- service_role bypass policies — which is what we want. `FORCE ROW
-- LEVEL SECURITY` would apply policies to service_role too and
-- instantly break every API route. Do NOT change to FORCE without
-- rewriting every server query to carry a tenant-aware JWT.
--
-- How to verify after running
-- ───────────────────────────
--
--   1. Sign out, sign back in. Confirm new JWT carries
--      `app_metadata.tenantId` in jwt.io.
--   2. Load the vault — file list still populates (server routes use
--      service_role, unaffected).
--   3. Open devtools console on the app page and run:
--        const { createClient } = await import('@supabase/supabase-js');
--        const c = createClient(
--          '<NEXT_PUBLIC_SUPABASE_URL>',
--          '<NEXT_PUBLIC_SUPABASE_ANON_KEY>'
--        );
--        // Without your session cookie → anon role → zero rows:
--        console.log(await c.from('files').select('*'));
--   4. Check that realtime events still arrive — open the app in
--      two browser tabs, rename a file in tab A, see tab B's vault
--      list update.
--
-- All statements are idempotent (DROP POLICY IF EXISTS; ALTER TABLE
-- ENABLE RLS is a no-op if already enabled). Safe to re-run.

-- ─── 1. Tables with a direct tenantId column ────────────────────────────

ALTER TABLE "files"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE "folders"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ecos"               ENABLE ROW LEVEL SECURITY;
ALTER TABLE "parts"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE "boms"               ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_requests"  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "files_tenant_select"             ON "files";
DROP POLICY IF EXISTS "folders_tenant_select"           ON "folders";
DROP POLICY IF EXISTS "ecos_tenant_select"              ON "ecos";
DROP POLICY IF EXISTS "parts_tenant_select"             ON "parts";
DROP POLICY IF EXISTS "boms_tenant_select"              ON "boms";
DROP POLICY IF EXISTS "approval_requests_tenant_select" ON "approval_requests";

CREATE POLICY "files_tenant_select" ON "files" FOR SELECT
  USING ("tenantId" = (auth.jwt() -> 'app_metadata' ->> 'tenantId'));

CREATE POLICY "folders_tenant_select" ON "folders" FOR SELECT
  USING ("tenantId" = (auth.jwt() -> 'app_metadata' ->> 'tenantId'));

CREATE POLICY "ecos_tenant_select" ON "ecos" FOR SELECT
  USING ("tenantId" = (auth.jwt() -> 'app_metadata' ->> 'tenantId'));

CREATE POLICY "parts_tenant_select" ON "parts" FOR SELECT
  USING ("tenantId" = (auth.jwt() -> 'app_metadata' ->> 'tenantId'));

CREATE POLICY "boms_tenant_select" ON "boms" FOR SELECT
  USING ("tenantId" = (auth.jwt() -> 'app_metadata' ->> 'tenantId'));

CREATE POLICY "approval_requests_tenant_select" ON "approval_requests" FOR SELECT
  USING ("tenantId" = (auth.jwt() -> 'app_metadata' ->> 'tenantId'));

-- ─── 2. Parent-scoped tables (no tenantId column) ───────────────────────
--
-- These tables check their parent's tenantId via EXISTS. The EXISTS
-- subquery runs under the same role as the outer query, so it passes
-- through the parent table's RLS policy — a second filter with the
-- same predicate. That's redundant but cheap, and it means the two
-- policies can't drift: if the parent's tenant is hidden, the child
-- is hidden too.

ALTER TABLE "file_versions"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "eco_items"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bom_items"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_decisions"  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "file_versions_tenant_select"      ON "file_versions";
DROP POLICY IF EXISTS "eco_items_tenant_select"          ON "eco_items";
DROP POLICY IF EXISTS "bom_items_tenant_select"          ON "bom_items";
DROP POLICY IF EXISTS "approval_decisions_tenant_select" ON "approval_decisions";

CREATE POLICY "file_versions_tenant_select" ON "file_versions" FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM "files"
    WHERE "files"."id" = "file_versions"."fileId"
      AND "files"."tenantId" = (auth.jwt() -> 'app_metadata' ->> 'tenantId')
  ));

CREATE POLICY "eco_items_tenant_select" ON "eco_items" FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM "ecos"
    WHERE "ecos"."id" = "eco_items"."ecoId"
      AND "ecos"."tenantId" = (auth.jwt() -> 'app_metadata' ->> 'tenantId')
  ));

CREATE POLICY "bom_items_tenant_select" ON "bom_items" FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM "boms"
    WHERE "boms"."id" = "bom_items"."bomId"
      AND "boms"."tenantId" = (auth.jwt() -> 'app_metadata' ->> 'tenantId')
  ));

CREATE POLICY "approval_decisions_tenant_select" ON "approval_decisions" FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM "approval_requests"
    WHERE "approval_requests"."id" = "approval_decisions"."requestId"
      AND "approval_requests"."tenantId" = (auth.jwt() -> 'app_metadata' ->> 'tenantId')
  ));

-- ─── 3. Per-user: notifications ─────────────────────────────────────────
--
-- Notifications are scoped by user, not tenant. A user in tenant X
-- should only see notifications addressed to them, not every
-- notification in their tenant. The `userId` column on notifications
-- references `tenant_users.id`, which migration 022 puts into the JWT
-- as `app_metadata.tenantUserId`.

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notifications_owner_select" ON "notifications";

CREATE POLICY "notifications_owner_select" ON "notifications" FOR SELECT
  USING ("userId" = (auth.jwt() -> 'app_metadata' ->> 'tenantUserId'));
