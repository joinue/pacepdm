-- PACE PDM Migration 021: Idempotency keys on approval requests
--
-- A double-clicked "Approve & Release" button — or a network retry on
-- POST /api/files/[fileId]/transition — currently creates two distinct
-- approval_requests rows. Both end up in the approvers' queue, both
-- can be approved separately, and both fire side effects when they
-- complete. The user experience is "why do I have two requests for the
-- same file" and the audit trail looks like the change was approved
-- twice.
--
-- Fix: an optional idempotency token. The transition route reads an
-- `Idempotency-Key` header from the client, passes it to startWorkflow,
-- and the engine inserts the key alongside the request. A unique index
-- on (tenantId, clientRequestKey) makes a duplicate insert collide at
-- the DB level (23505), at which point the engine fetches the existing
-- request and returns its ID instead of creating a new one.
--
-- The column is nullable so callers that don't supply a key behave
-- exactly as before. The unique index is partial (WHERE clientRequestKey
-- IS NOT NULL) so unkeyed requests don't conflict with each other.
--
-- Run this in the Supabase SQL Editor. Idempotent.

ALTER TABLE "approval_requests"
  ADD COLUMN IF NOT EXISTS "clientRequestKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "approval_requests_tenantId_clientRequestKey_key"
  ON "approval_requests" ("tenantId", "clientRequestKey")
  WHERE "clientRequestKey" IS NOT NULL;
