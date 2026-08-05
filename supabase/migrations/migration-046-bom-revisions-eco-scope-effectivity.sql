-- PACE PDM Migration 046: BOM revisions, ECO scope over BOMs, effectivity
--
-- Three gaps found reviewing the change-control workflow end to end. They
-- share a migration because they are one story: a BOM cannot currently be
-- revised, the change order that ought to govern that revision cannot
-- reference it, and nothing records when the change takes effect.
--
-- ── 1. BOM revision lineage ─────────────────────────────────────────────
--
-- The blocking gap. `BOM_STATUS_FLOW` allows RELEASED → OBSOLETE and
-- nothing after it, and `bom_items` refuses edits on both. So releasing a
-- BOM made it permanently unchangeable: no path to revision B, only
-- obsolescence, which is terminal. Files already had this (Released → WIP
-- bumps the revision and unfreezes), so BOMs lacking it was an omission
-- rather than a position.
--
-- Modelled the way PLM systems do it: a revision is a NEW object with
-- lineage, not a mutation of the old one. Revision A stays frozen and keeps
-- its baseline, released documents that cite it stay accurate, and B starts
-- as a copy in DRAFT.
--
--   previousRevisionId — the revision this one was created from
--   supersededById     — set on the OLD row when the new one is released,
--                        so "is this the current revision" is one column
--                        rather than a walk of the chain
--
-- Deliberately NOT done: repointing parent BOMs at the new revision. A
-- parent that cites revision A continues to cite revision A, because that
-- is what its own release said. Moving a parent to a new child revision is
-- a change to the parent, and therefore an ECO — which is what item 2 makes
-- possible.
--
-- ── 2. ECOs can contain a BOM ───────────────────────────────────────────
--
-- `eco_items` carries `fileId` and `partId` but no `bomId`, so a change
-- order could govern a part revision and not the BOM revision that goes
-- with it. In Windchill and Arena a change order covers the item AND its
-- structure; that is the point of a change order. `bom-impact` could
-- already analyse the blast radius, but nothing linked the result to the
-- ECO that caused it.
--
-- ── 3. Effectivity ──────────────────────────────────────────────────────
--
-- `ecos.effectivity` is free text. Nobody can query it, so "which BOM
-- shipped on unit 47" and "what is in effect on 1 March" are both
-- unanswerable. Replaced with typed columns, keeping the prose one as a
-- note. Date and serial effectivity are the two forms in general use;
-- `effectivityType` says which applies rather than leaving readers to infer
-- it from which column is populated.
--
-- Re-runnable.

-- ── 1. BOM revision lineage ─────────────────────────────────────────────

ALTER TABLE "boms" ADD COLUMN IF NOT EXISTS "previousRevisionId" TEXT;
ALTER TABLE "boms" ADD COLUMN IF NOT EXISTS "supersededById" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boms_previousRevisionId_fkey') THEN
    ALTER TABLE "boms" ADD CONSTRAINT "boms_previousRevisionId_fkey"
      FOREIGN KEY ("previousRevisionId") REFERENCES "boms"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boms_supersededById_fkey') THEN
    ALTER TABLE "boms" ADD CONSTRAINT "boms_supersededById_fkey"
      FOREIGN KEY ("supersededById") REFERENCES "boms"("id") ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "boms_previousRevisionId_idx" ON "boms" ("previousRevisionId");

-- The BOM list shows current revisions only, which is this predicate.
CREATE INDEX IF NOT EXISTS "boms_tenantId_current_idx"
  ON "boms" ("tenantId") WHERE "supersededById" IS NULL AND "deletedAt" IS NULL;

-- The name/revision pair identifies a BOM, and two live rows must not claim
-- the same one. Partial so superseded and deleted rows do not block reuse.
CREATE UNIQUE INDEX IF NOT EXISTS "boms_tenantId_name_revision_key"
  ON "boms" ("tenantId", "name", "revision")
  WHERE "deletedAt" IS NULL;

-- ── 2. ECOs can contain a BOM ───────────────────────────────────────────

ALTER TABLE "eco_items" ADD COLUMN IF NOT EXISTS "bomId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eco_items_bomId_fkey') THEN
    ALTER TABLE "eco_items" ADD CONSTRAINT "eco_items_bomId_fkey"
      FOREIGN KEY ("bomId") REFERENCES "boms"("id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "eco_items_bomId_idx" ON "eco_items" ("bomId");

-- One line per BOM per ECO, matching the existing fileId and partId keys.
CREATE UNIQUE INDEX IF NOT EXISTS "eco_items_ecoId_bomId_key"
  ON "eco_items" ("ecoId", "bomId") WHERE "bomId" IS NOT NULL;

-- ── 3. Effectivity ──────────────────────────────────────────────────────

ALTER TABLE "ecos" ADD COLUMN IF NOT EXISTS "effectivityType" TEXT;
ALTER TABLE "ecos" ADD COLUMN IF NOT EXISTS "effectiveFrom" TIMESTAMP(3);
ALTER TABLE "ecos" ADD COLUMN IF NOT EXISTS "effectiveSerial" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ecos_effectivityType_check') THEN
    ALTER TABLE "ecos" ADD CONSTRAINT "ecos_effectivityType_check"
      CHECK ("effectivityType" IS NULL OR "effectivityType" IN ('IMMEDIATE', 'DATE', 'SERIAL'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "ecos_tenantId_effectiveFrom_idx"
  ON "ecos" ("tenantId", "effectiveFrom") WHERE "effectiveFrom" IS NOT NULL;

-- The prose `effectivity` column is left in place and still shown. It holds
-- whatever people already wrote there, and no automated reading of it would
-- be safe.

-- ── Verification ────────────────────────────────────────────────────────
--
--   select count(*) from boms where "supersededById" is null and "deletedAt" is null;
--   -- every existing BOM is current; nothing is superseded by this migration
--
--   select column_name from information_schema.columns
--    where table_name = 'ecos' and column_name like 'effectiv%';
--   -- effectivity, effectivityType, effectiveFrom, effectiveSerial
--
-- RLS: no new tables (migrations 023 and 039 still apply).
