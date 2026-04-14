-- PACE PDM Migration 031: SAML / SSO support
--
-- Wires domain-based SSO on top of Supabase's built-in SAML provider
-- registry. Supabase stores the IdP metadata and domain-to-provider
-- mapping at the project level (configured via the Supabase dashboard
-- or the Admin API). We only need to record, per tenant, which email
-- domains route SSO users into which tenant + what role they should
-- land in on first login.
--
-- JIT provisioning: when a Supabase-authed user has no tenant_users
-- row, `findTenantUser` matches their email domain against this table
-- and creates the row with `jitRoleId` and `ssoProvisioned=true`.
--
-- Single-tenant-per-user is enforced by unique(domain): two tenants
-- cannot both claim `acme.com`. If a user already has a tenant_users
-- row in a *different* tenant than the one their SSO domain points to,
-- the existing row wins (block semantics — we do not silently migrate
-- them across tenants).
--
-- Per project convention, run in the Supabase SQL Editor. Idempotent.

CREATE TABLE IF NOT EXISTS "tenant_sso_domains" (
  "id" text PRIMARY KEY,
  "tenantId" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "domain" text NOT NULL UNIQUE,
  "jitRoleId" text NOT NULL REFERENCES "roles"("id"),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "tenant_sso_domains_tenantId_idx"
  ON "tenant_sso_domains" ("tenantId");

ALTER TABLE "tenant_users"
  ADD COLUMN IF NOT EXISTS "ssoProvisioned" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "lastSsoLoginAt" timestamptz;
