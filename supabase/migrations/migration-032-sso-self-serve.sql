-- PACE PDM Migration 032: self-serve SSO
--
-- Extends `tenant_sso_domains` (from migration-031) with the state
-- needed for a tenant admin to register their own SAML provider end-
-- to-end, without operator intervention:
--
--   status               — where we are in the lifecycle
--   verificationToken    — random nonce the admin proves ownership of
--                          via a DNS TXT record at
--                          _pacepdm-verify.<domain>
--   verifiedAt           — when DNS verification last succeeded
--   providerId           — Supabase SSO provider UUID (returned by the
--                          Auth Admin API after we ingest metadata)
--   metadataUrl          — optional public URL for the IdP metadata,
--                          stored so we can re-ingest on cert rotation
--
-- Security note: DNS verification is load-bearing. Without it, one
-- admin could claim another company's domain (`google.com`) and
-- silently hijack every future SSO login from that domain. No row
-- with status != 'pending_verification' is honored by the signInWithSSO
-- flow — the domain resolver API only returns a match when
-- status = 'active'.
--
-- Idempotent. Run in Supabase SQL Editor.

ALTER TABLE "tenant_sso_domains"
  ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'pending_verification',
  ADD COLUMN IF NOT EXISTS "verificationToken" text,
  ADD COLUMN IF NOT EXISTS "verifiedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "providerId" text,
  ADD COLUMN IF NOT EXISTS "metadataUrl" text;

DO $$ BEGIN
  ALTER TABLE "tenant_sso_domains"
    ADD CONSTRAINT "tenant_sso_domains_status_check"
    CHECK ("status" IN ('pending_verification', 'verified', 'active', 'error'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Backfill: any row that existed before this migration was created by
-- migration-031's admin UI, which had no verification step. Mark those
-- rows as 'active' so they keep working — operators added them by hand
-- and we trust operator-level writes. New rows always start as
-- 'pending_verification'.
UPDATE "tenant_sso_domains"
SET "status" = 'active', "verifiedAt" = now()
WHERE "status" = 'pending_verification' AND "verificationToken" IS NULL;
