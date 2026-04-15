-- PACE PDM Migration 033: release packages
--
-- A "release" is an immutable, self-contained snapshot of everything
-- an ECO shipped: the parts it bumped (from-rev → to-rev), the files
-- it moved to Released (with exact frozen version IDs and storage
-- keys), and the BOMs whose parent files were affected (inlined
-- snapshot data so the release is independent of later BOM mutations
-- or deletions).
--
-- Releases are created exactly once per ECO, by the implement_eco
-- handler, immediately after the RPC returns. The unique index on
-- ecoId enforces "at most one release per ECO" idempotently — a
-- retry of the implement call (which can't actually re-run on an
-- already-IMPLEMENTED ECO) cannot double-create a release.
--
-- Why a single jsonb manifest instead of release_parts / release_files
-- / release_bom_snapshots child tables:
--   1. Matches the existing `bom_snapshots.items` philosophy — snapshots
--      are self-contained and never reach into live tables for display.
--   2. A release that references a now-deleted part or BOM still
--      renders correctly because the names, revisions, and metadata
--      live in the manifest, not in a join.
--   3. A release page fetches one row; the child-table version would
--      need 3 joins to render the same thing.
--
-- The trade-off is that we can't do "show me every release that
-- contained part X" without a jsonb scan. That query is rare enough
-- that it's not worth normalizing for.
--
-- Also: extends `share_tokens.resourceType` check constraint to
-- include 'release', so a release can be wrapped in a public share
-- link the same way files and BOMs can.
--
-- Per project convention, run in the Supabase SQL Editor. Idempotent.

CREATE TABLE IF NOT EXISTS "releases" (
  "id" text PRIMARY KEY,
  "tenantId" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "ecoId" text NOT NULL REFERENCES "ecos"("id") ON DELETE RESTRICT,
  "ecoNumber" text NOT NULL,
  "name" text NOT NULL,
  "releasedAt" timestamptz NOT NULL DEFAULT now(),
  "releasedById" text REFERENCES "tenant_users"("id") ON DELETE SET NULL,
  "note" text,
  "manifest" jsonb NOT NULL
);

-- One release per ECO. This is the idempotency guarantee — if the
-- implement handler is ever retried, the INSERT will fail on this
-- unique index and the caller logs-and-continues.
CREATE UNIQUE INDEX IF NOT EXISTS "releases_ecoId_unique"
  ON "releases" ("ecoId");

-- Listing for "recent releases in this tenant" — the eventual /releases
-- list page. Cheap even without that page existing.
CREATE INDEX IF NOT EXISTS "releases_tenant_released_idx"
  ON "releases" ("tenantId", "releasedAt" DESC);

-- Extend share_tokens.resourceType to allow 'release'. The original
-- check constraint was added in migration-030 with exactly two values;
-- we drop and recreate it here. Wrapped in a DO block so re-running
-- this migration is safe even after the new constraint is in place.
DO $$ BEGIN
  ALTER TABLE "share_tokens"
    DROP CONSTRAINT IF EXISTS "share_tokens_resourceType_check";
  ALTER TABLE "share_tokens"
    ADD CONSTRAINT "share_tokens_resourceType_check"
    CHECK ("resourceType" IN ('file', 'bom', 'release'));
END $$;
