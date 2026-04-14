-- PACE PDM Migration 027: BOM baselines (immutable release snapshots)
--
-- Problem we're solving: once a BOM transitions to RELEASED, the current
-- schema locks *further edits* but doesn't preserve "the exact shape of
-- the BOM at the moment it was released". If the BOM later gets revised
-- (new revision bump, new items), there's no way to answer the PDM's
-- most important audit question: "what was the BOM when we shipped v1?"
--
-- `bom_snapshots` is a write-once log of baseline rows. Each row captures:
--   - the BOM identifiers and display metadata as they were at snapshot time
--     (name, revision, status, item count, rollup totals)
--   - the full item list as a JSONB payload (with joined part data already
--     denormalized in — the snapshot must remain intact even if parts are
--     later deleted or renamed)
--   - who/what triggered the snapshot: a manual release, an ECO implement,
--     or an explicit "capture baseline" action from the UI
--
-- A snapshot is created automatically when a BOM transitions to RELEASED
-- via the PUT /api/boms/[bomId] endpoint, and can also be created
-- manually. Snapshots are immutable — there is no UPDATE path in the
-- application layer. Deletion is allowed only when the parent BOM is
-- deleted (ON DELETE CASCADE) so orphan rows can't accumulate.
--
-- Per project convention, run in the Supabase SQL Editor. All statements
-- are idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS "bom_snapshots" (
  "id" text PRIMARY KEY,
  "tenantId" text NOT NULL REFERENCES "tenants"("id"),
  "bomId" text NOT NULL REFERENCES "boms"("id") ON DELETE CASCADE,

  -- Snapshotted display fields. These are denormalized on purpose so a
  -- rename of the BOM after the snapshot doesn't rewrite the baseline.
  "bomName" text NOT NULL,
  "bomRevision" text NOT NULL,
  "bomStatus" text NOT NULL,

  -- What triggered the snapshot. 'RELEASE' is the common case (BOM
  -- status transitioned to RELEASED). 'MANUAL' is an explicit user
  -- action from the UI. 'ECO_IMPLEMENT' is reserved for a future hook
  -- when ECO implement starts releasing BOMs transitively.
  "trigger" text NOT NULL CHECK ("trigger" IN ('RELEASE','MANUAL','ECO_IMPLEMENT')),
  "ecoId" text REFERENCES "ecos"("id"),

  -- Full line-item payload plus rollup totals at snapshot time. JSONB
  -- so we can evolve the shape without migrations and still query it
  -- cheaply when needed. See `src/lib/bom-snapshot.ts` for the shape.
  "items" jsonb NOT NULL,
  "metrics" jsonb NOT NULL,

  "snapshotAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" text REFERENCES "tenant_users"("id"),

  -- Human-readable note (optional) — used by the "Capture baseline"
  -- action so users can explain why they took a manual snapshot.
  "note" text
);

-- Primary read path: list baselines for a specific BOM, newest first.
CREATE INDEX IF NOT EXISTS "bom_snapshots_bomId_snapshotAt_idx"
  ON "bom_snapshots" ("bomId", "snapshotAt" DESC);

-- Tenant scoping for any list view that spans BOMs (e.g. a future
-- "recent baselines across the tenant" dashboard panel).
CREATE INDEX IF NOT EXISTS "bom_snapshots_tenantId_snapshotAt_idx"
  ON "bom_snapshots" ("tenantId", "snapshotAt" DESC);
