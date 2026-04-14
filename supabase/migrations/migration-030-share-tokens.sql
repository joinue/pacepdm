-- PACE PDM Migration 030: public share tokens
--
-- Adds the table that backs the "share link" feature: tokenized,
-- read-only URLs that an internal user can generate for a single
-- file or BOM and send to an external partner (contract manufacturer,
-- vendor, reviewer) without giving them a login.
--
-- Design notes:
--   - `resourceType` + `resourceId` is polymorphic by design. There is
--     no DB-level FK on resourceId — the resource may be a file, a BOM,
--     or (later) a release. Application code validates the target
--     exists and belongs to the tenant at creation time.
--   - `token` is the url-safe random string embedded in the share URL
--     (`/share/:token`). Unique index so lookups by token are O(1).
--   - `passwordHash` stores scrypt hash+salt as "salt:hash" (both hex).
--     No bcrypt dependency — we use node's built-in crypto.scrypt.
--   - `revokedAt` is a soft-delete column. Revoking a token never
--     deletes the row because the audit log still references it and
--     we want to show "revoked" instead of "not found" on the public
--     page. Expired tokens are handled by `expiresAt`, which is nullable
--     (NULL = never expires — the intentional default).
--   - Access counting is lightweight: increment `accessCount` and
--     update `lastAccessedAt` on every public fetch. No per-access
--     log table in v1 — add later if we need IP/UA forensics.
--
-- Per project convention, run in the Supabase SQL Editor. Idempotent.

CREATE TABLE IF NOT EXISTS "share_tokens" (
  "id" text PRIMARY KEY,
  "tenantId" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "token" text NOT NULL UNIQUE,
  "resourceType" text NOT NULL,
  "resourceId" text NOT NULL,
  "createdById" text REFERENCES "tenant_users"("id") ON DELETE SET NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "expiresAt" timestamptz,
  "revokedAt" timestamptz,
  "allowDownload" boolean NOT NULL DEFAULT true,
  "passwordHash" text,
  "label" text,
  "accessCount" integer NOT NULL DEFAULT 0,
  "lastAccessedAt" timestamptz,
  CONSTRAINT "share_tokens_resourceType_check"
    CHECK ("resourceType" IN ('file', 'bom'))
);

-- Listing share links by resource ("what links exist for this file?")
-- is the hot path for the share dialog. Filters by tenant + resource.
CREATE INDEX IF NOT EXISTS "share_tokens_resource_idx"
  ON "share_tokens" ("tenantId", "resourceType", "resourceId");

-- Dashboard-style "my active share links" lookup.
CREATE INDEX IF NOT EXISTS "share_tokens_tenant_created_idx"
  ON "share_tokens" ("tenantId", "createdAt" DESC);
