-- PACE PDM Migration 036: soft-delete columns, missing FK indexes
--
-- 1. Add deletedAt to files, parts, boms, ecos for soft-delete support.
--    Queries must filter with WHERE "deletedAt" IS NULL to exclude deleted rows.
--    Partial indexes ensure soft-deleted rows don't slow down normal queries.
--
-- 2. Add missing FK indexes on eco_items and bom_items for join performance.

-- ── Soft-delete columns ──────────────────────────────────────────────────

ALTER TABLE "files" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "parts" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "boms" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "ecos" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- Partial indexes: most queries only care about non-deleted rows.
-- These keep list-page queries fast as deleted rows accumulate.
CREATE INDEX "files_tenantId_active_idx" ON "files" ("tenantId", "folderId") WHERE "deletedAt" IS NULL;
CREATE INDEX "parts_tenantId_active_idx" ON "parts" ("tenantId") WHERE "deletedAt" IS NULL;
CREATE INDEX "boms_tenantId_active_idx" ON "boms" ("tenantId") WHERE "deletedAt" IS NULL;
CREATE INDEX "ecos_tenantId_active_idx" ON "ecos" ("tenantId") WHERE "deletedAt" IS NULL;

-- ── Missing FK indexes ───────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "eco_items_ecoId_idx" ON "eco_items" ("ecoId");
CREATE INDEX IF NOT EXISTS "eco_items_fileId_idx" ON "eco_items" ("fileId");
CREATE INDEX IF NOT EXISTS "bom_items_bomId_idx" ON "bom_items" ("bomId");
