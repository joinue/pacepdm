-- PACE PDM Migration 005: Parts Master List, Vendors, Sub-Assembly Linking
-- Run this in Supabase SQL Editor

-- Parts master list — the central object in the PDM
CREATE TABLE "parts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "partNumber" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'MANUFACTURED',
    "revision" TEXT NOT NULL DEFAULT 'A',
    "lifecycleState" TEXT NOT NULL DEFAULT 'WIP',
    "material" TEXT,
    "weight" DOUBLE PRECISION,
    "weightUnit" TEXT DEFAULT 'kg',
    "unitCost" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "unit" TEXT NOT NULL DEFAULT 'EA',
    "thumbnailUrl" TEXT,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "parts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "parts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
    CONSTRAINT "parts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "tenant_users"("id")
);

CREATE UNIQUE INDEX "parts_tenantId_partNumber_key" ON "parts"("tenantId", "partNumber");
CREATE INDEX "parts_tenantId_category_idx" ON "parts"("tenantId", "category");
CREATE INDEX "parts_tenantId_name_idx" ON "parts"("tenantId", "name");

-- Valid categories: MANUFACTURED, PURCHASED, STANDARD_HARDWARE, RAW_MATERIAL, SUB_ASSEMBLY

-- Part-to-file links (a part can have multiple files: drawing, 3D model, spec sheet)
CREATE TABLE "part_files" (
    "id" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'DRAWING',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "part_files_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "part_files_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE CASCADE,
    CONSTRAINT "part_files_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "part_files_partId_fileId_key" ON "part_files"("partId", "fileId");
-- Valid roles: DRAWING, MODEL_3D, SPEC_SHEET, DATASHEET, OTHER

-- Approved vendors per part (primary + alternates)
CREATE TABLE "part_vendors" (
    "id" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "vendorName" TEXT NOT NULL,
    "vendorPartNumber" TEXT,
    "unitCost" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "leadTimeDays" INTEGER,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "part_vendors_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "part_vendors_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE CASCADE
);

CREATE INDEX "part_vendors_partId_idx" ON "part_vendors"("partId");

-- Link BOM items to the parts master list instead of loose text fields
ALTER TABLE "bom_items" ADD COLUMN IF NOT EXISTS "partId" TEXT;
ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_partId_fkey"
    FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE SET NULL;

-- Link BOM items to sub-assembly BOMs
ALTER TABLE "bom_items" ADD COLUMN IF NOT EXISTS "linkedBomId" TEXT;
ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_linkedBomId_fkey"
    FOREIGN KEY ("linkedBomId") REFERENCES "boms"("id") ON DELETE SET NULL;

CREATE INDEX "bom_items_partId_idx" ON "bom_items"("partId");
CREATE INDEX "bom_items_linkedBomId_idx" ON "bom_items"("linkedBomId");
