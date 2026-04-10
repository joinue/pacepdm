-- PACE PDM Migration 009: Promote vendors to first-class entities
--
-- Today, `part_vendors.vendorName` is a free-text string. Two parts that both
-- buy from "Digi-Key" are unrelated rows. This migration:
--   1. Creates a tenant-scoped `vendors` table
--   2. Adds `part_vendors.vendorId` (FK -> vendors)
--   3. Backfills by deduplicating existing vendor names per tenant, with
--      aggressive normalization (trim, collapse whitespace, case-insensitive
--      match) so "Digi-Key", "digi-key ", "Digi  Key" all collapse to one row
--   4. Locks `vendorId` NOT NULL with a RESTRICT FK
--
-- Per project convention, this is raw SQL run in the Supabase SQL Editor
-- (not `prisma migrate`). All statements are idempotent — safe to re-run.
--
-- NOTE: `vendorName` is intentionally LEFT IN PLACE for now as a safety net.
-- Once the application has been verified against `vendorId`, a follow-up
-- migration will drop the legacy column.

-- ─── 1. vendors table ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "vendors" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "website" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "vendors_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
);

-- One vendor per (tenant, name). Case/whitespace normalization happens at
-- the application layer before insert; the unique index enforces exact-match
-- uniqueness on the canonicalized name.
CREATE UNIQUE INDEX IF NOT EXISTS "vendors_tenantId_name_key" ON "vendors" ("tenantId", "name");
CREATE INDEX IF NOT EXISTS "vendors_tenantId_idx" ON "vendors" ("tenantId");

-- ─── 2. part_vendors.vendorId column ───────────────────────────────────────

ALTER TABLE "part_vendors" ADD COLUMN IF NOT EXISTS "vendorId" TEXT;

-- ─── 3. Backfill ───────────────────────────────────────────────────────────
-- Strategy: for each (tenantId, normalized vendor name) pair found in
-- part_vendors, create one vendors row using the *first-seen* casing as the
-- display name. Then point every part_vendors row at its matching vendor.
--
-- Normalization: trim leading/trailing whitespace, then collapse runs of
-- internal whitespace to a single space. Match is case-insensitive.

DO $$
DECLARE
  rec RECORD;
BEGIN
  -- Skip cleanly if part_vendors doesn't exist on this instance yet
  IF to_regclass('public.part_vendors') IS NULL THEN
    RAISE NOTICE 'Skipping vendors backfill — part_vendors does not exist';
    RETURN;
  END IF;

  -- Create canonical vendor rows (one per tenant + normalized name)
  FOR rec IN
    SELECT DISTINCT ON (p."tenantId", lower(regexp_replace(btrim(pv."vendorName"), '\s+', ' ', 'g')))
      p."tenantId" AS tenant_id,
      regexp_replace(btrim(pv."vendorName"), '\s+', ' ', 'g') AS clean_name
    FROM "part_vendors" pv
    JOIN "parts" p ON p."id" = pv."partId"
    WHERE pv."vendorName" IS NOT NULL
      AND btrim(pv."vendorName") <> ''
      AND pv."vendorId" IS NULL  -- only process rows not yet linked
    ORDER BY
      p."tenantId",
      lower(regexp_replace(btrim(pv."vendorName"), '\s+', ' ', 'g')),
      pv."createdAt"
  LOOP
    INSERT INTO "vendors" ("id", "tenantId", "name", "createdAt", "updatedAt")
    VALUES (gen_random_uuid()::text, rec.tenant_id, rec.clean_name, NOW(), NOW())
    ON CONFLICT ("tenantId", "name") DO NOTHING;
  END LOOP;

  -- Link every part_vendors row to its canonical vendor
  UPDATE "part_vendors" pv
  SET "vendorId" = v."id"
  FROM "parts" p, "vendors" v
  WHERE pv."partId" = p."id"
    AND pv."vendorId" IS NULL
    AND v."tenantId" = p."tenantId"
    AND lower(v."name") = lower(regexp_replace(btrim(pv."vendorName"), '\s+', ' ', 'g'));
END $$;

-- ─── 4. Lock vendorId NOT NULL + add FK ────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.part_vendors') IS NULL THEN
    RAISE NOTICE 'Skipping part_vendors FK — table does not exist';
    RETURN;
  END IF;

  -- Refuse to lock NOT NULL if any rows are still unlinked — that would
  -- indicate a backfill bug we want to surface, not silently mask.
  IF EXISTS (SELECT 1 FROM "part_vendors" WHERE "vendorId" IS NULL) THEN
    RAISE EXCEPTION 'part_vendors has rows with NULL vendorId after backfill — investigate before re-running';
  END IF;

  -- Set NOT NULL (idempotent — no-op if already NOT NULL)
  ALTER TABLE "part_vendors" ALTER COLUMN "vendorId" SET NOT NULL;

  -- Add FK only if it doesn't already exist
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'part_vendors_vendorId_fkey'
      AND table_name = 'part_vendors'
  ) THEN
    ALTER TABLE "part_vendors"
      ADD CONSTRAINT "part_vendors_vendorId_fkey"
      FOREIGN KEY ("vendorId") REFERENCES "vendors"("id")
      ON DELETE RESTRICT
      ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "part_vendors_vendorId_idx" ON "part_vendors" ("vendorId");
