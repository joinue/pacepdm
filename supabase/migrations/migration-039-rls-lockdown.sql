-- PACE PDM Migration 039: RLS lockdown on all remaining tables
--
-- Closes a confirmed critical exposure. Migration 023 enabled RLS on the
-- 11 tables the browser subscribes to via realtime. It deliberately left
-- the other 29 alone, on the reasoning that "the browser never queries
-- these directly today."
--
-- That reasoning applies the wrong threat model. What the browser does is
-- irrelevant: NEXT_PUBLIC_SUPABASE_ANON_KEY ships in the JS bundle, so it
-- is public by definition, and PostgREST is reachable by anyone with curl.
-- Supabase's default grants give `anon` full DML on the public schema, and
-- a table with RLS disabled has nothing else standing in the way.
--
-- Verified against the live project before writing this migration:
--
--   GET    /rest/v1/tenant_users  → 206  Content-Range: 0-0/5
--   GET    /rest/v1/share_tokens  → 206  Content-Range: 0-0/3
--   GET    /rest/v1/audit_logs    → 206  Content-Range: 0-0/102
--   GET    /rest/v1/files         → 200  Content-Range: */0    (023 working)
--   DELETE /rest/v1/audit_logs?id=eq.<no-match>  → 204         (write granted)
--
-- So, unauthenticated and from anywhere: read every user's email, read
-- every share-link token (which grants download of the underlying files
-- in every tenant), read the full audit trail — and delete or rewrite any
-- of it, including the audit trail that would record the tampering.
--
-- Deny-all, not policies
-- ──────────────────────
--
-- Every one of these 29 tables is reached exclusively through server code
-- using getServiceClient() (service_role), which bypasses RLS. None is in
-- a realtime subscription — the 10 subscribed tables are all covered by
-- 023 already. So enabling RLS with NO policies at all is both sufficient
-- and non-breaking: anon and authenticated get zero rows and every write
-- is refused, while every existing server route is untouched.
--
-- This is deliberately narrower than 023's approach. Writing SELECT
-- policies here would mean guessing at claim shapes for tables nothing
-- currently reads from the browser. When a future feature does need
-- browser access to one of these, add the policy in that feature's PR,
-- where the required shape is actually known.
--
-- Permissive, not FORCE — same as 023. FORCE would apply policies to
-- service_role too and instantly break every API route.
--
-- Idempotent: ENABLE ROW LEVEL SECURITY is a no-op when already enabled.
-- Safe to re-run.

-- ── Identity & access ────────────────────────────────────────────────────
-- tenant_users leaks every user's email and full name; roles and
-- tenant_sso_domains describe the tenant's whole auth surface.

ALTER TABLE "tenants"                        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_users"                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "roles"                          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_sso_domains"             ENABLE ROW LEVEL SECURITY;

-- ── Share links ──────────────────────────────────────────────────────────
-- Highest-impact table in this migration: share_tokens.token is the
-- bearer credential for public file/BOM/release access. Readable here
-- meant every private share link in every tenant was effectively public.

ALTER TABLE "share_tokens"                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "share_token_access"             ENABLE ROW LEVEL SECURITY;

-- ── Audit & compliance ───────────────────────────────────────────────────
-- Writable audit_logs / approval_history defeats the point of having them
-- (21 CFR Part 11, ISO 9001, SOC 2 all assume an append-only trail).

ALTER TABLE "audit_logs"                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_history"               ENABLE ROW LEVEL SECURITY;

-- ── Approval configuration & state ───────────────────────────────────────
-- Write access here lets an attacker add themselves to an approval group
-- or rewrite a workflow, which forges a release path.

ALTER TABLE "approval_groups"                ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_group_members"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_workflows"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_workflow_steps"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_workflow_assignments"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_reminders"             ENABLE ROW LEVEL SECURITY;

-- ── Lifecycle configuration ──────────────────────────────────────────────

ALTER TABLE "lifecycles"                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lifecycle_states"               ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lifecycle_transitions"          ENABLE ROW LEVEL SECURITY;

-- ── Folder access control ────────────────────────────────────────────────
-- folder_access is the ACL table itself; write access to it is write
-- access to every folder permission in the system.

ALTER TABLE "folder_access"                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "folder_permissions"             ENABLE ROW LEVEL SECURITY;

-- ── Engineering data not already covered by 023 ──────────────────────────

ALTER TABLE "file_references"                ENABLE ROW LEVEL SECURITY;
ALTER TABLE "metadata_fields"                ENABLE ROW LEVEL SECURITY;
ALTER TABLE "metadata_values"                ENABLE ROW LEVEL SECURITY;
ALTER TABLE "part_files"                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "part_vendors"                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vendors"                        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bom_snapshots"                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "releases"                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "saved_searches"                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE "comment_mentions"               ENABLE ROW LEVEL SECURITY;

-- ── Verification ─────────────────────────────────────────────────────────
--
-- 1. Run this query. It must return zero rows — every table in the public
--    schema should have RLS enabled after this migration.
--
--      SELECT tablename
--      FROM pg_tables
--      WHERE schemaname = 'public' AND NOT rowsecurity
--      ORDER BY tablename;
--
-- 2. From a shell, with the anon key. Every one of these must come back
--    empty (Content-Range: */0) rather than with a row count:
--
--      curl -sI -H "apikey: $ANON" -H "Prefer: count=exact" -H "Range: 0-0" \
--        "$URL/rest/v1/share_tokens?select=id" | grep -i content-range
--
--    Repeat for tenant_users, audit_logs, roles.
--
-- 3. Exercise the app: sign in, load the vault, open Admin → Users,
--    open the audit log, create and revoke a share link. All of these go
--    through service_role and must be unaffected.
--
-- ── Follow-up (not in this migration) ────────────────────────────────────
--
-- Existing share_tokens rows should be treated as compromised — their
-- token values were publicly readable for as long as the table was
-- exposed. Revoke and reissue:
--
--   UPDATE "share_tokens" SET "revokedAt" = now() WHERE "revokedAt" IS NULL;
--
-- That is a destructive, product-visible action (every live share link
-- stops working and has to be re-sent to recipients), so it is left as a
-- deliberate decision rather than bundled into this migration.
