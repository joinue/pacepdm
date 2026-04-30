-- PACE PDM Migration 037: per-access log for share tokens
--
-- Records every public hit on a share link: the resolve probe, password
-- attempts (including failures), content views, and downloads. Backs the
-- "View activity" panel in the share dialog and gives security a forensic
-- trail when a link gets misused.
--
-- Design notes:
--   - Separate table from audit_logs. audit_logs is for authenticated
--     admin actions and uses entityId polymorphically; querying "all hits
--     for token X" through it would mean filtering on a JSON detail field.
--     A purpose-built table keeps the activity panel query a single
--     indexed scan and isolates PII (ipAddress, userAgent) so it can be
--     purged on its own retention schedule.
--   - `action` enum mirrors the public entry points. Add new values via
--     a follow-up ALTER ... DROP CONSTRAINT / ADD CONSTRAINT migration.
--   - `success = false` rows record meaningful failures (wrong password,
--     resolve hit on a revoked/expired token). They're a security signal
--     more than a usage signal -- surfaced in the UI with a distinct row
--     style.
--   - `tokenId` FK is ON DELETE CASCADE: if a share row is ever hard
--     deleted (it normally isn't -- we soft-revoke), drop its log too.
--   - Retention: recommend a 90-day purge job. Not enforced in this
--     migration; the (createdAt) index makes the bulk delete cheap.
--
-- Per project convention, run in the Supabase SQL Editor. Idempotent.

CREATE TABLE IF NOT EXISTS "share_token_access" (
  "id" text PRIMARY KEY,
  "tenantId" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "tokenId" text NOT NULL REFERENCES "share_tokens"("id") ON DELETE CASCADE,
  "resourceType" text NOT NULL,
  "resourceId" text NOT NULL,
  "action" text NOT NULL,
  "success" boolean NOT NULL DEFAULT true,
  "failureReason" text,
  "fileId" text,
  "ipAddress" text,
  "userAgent" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "share_token_access_action_check"
    CHECK ("action" IN (
      'resolve', 'unlock', 'view-content', 'download', 'zip-download'
    )),
  CONSTRAINT "share_token_access_resourceType_check"
    CHECK ("resourceType" IN ('file', 'bom', 'release'))
);

-- Activity panel: "all accesses for token X, newest first."
CREATE INDEX IF NOT EXISTS "share_token_access_token_created_idx"
  ON "share_token_access" ("tokenId", "createdAt" DESC);

-- Retention sweeps and tenant-wide reporting.
CREATE INDEX IF NOT EXISTS "share_token_access_tenant_created_idx"
  ON "share_token_access" ("tenantId", "createdAt" DESC);
