-- PACE PDM Migration 034: idempotency keys for create mutations
--
-- Adds an optional clientRequestKey column to boms and ecos tables so
-- POST endpoints can de-duplicate retries. A unique partial index on
-- (tenantId, clientRequestKey) WHERE clientRequestKey IS NOT NULL
-- prevents duplicate creation when the same idempotency key is sent
-- twice. Follows the same pattern as approval_requests.

ALTER TABLE boms ADD COLUMN IF NOT EXISTS "clientRequestKey" TEXT;
ALTER TABLE ecos ADD COLUMN IF NOT EXISTS "clientRequestKey" TEXT;

-- Partial unique index — only enforced when a key is present.
CREATE UNIQUE INDEX IF NOT EXISTS boms_tenant_idempotency_key
  ON boms ("tenantId", "clientRequestKey")
  WHERE "clientRequestKey" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ecos_tenant_idempotency_key
  ON ecos ("tenantId", "clientRequestKey")
  WHERE "clientRequestKey" IS NOT NULL;
