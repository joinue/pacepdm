-- PACE PDM Migration 003: Revisions, Frozen State, BOM, Custom Roles, Folder Permissions
-- Run this in Supabase SQL Editor

-- Add revision letter and frozen flag to files
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "revision" TEXT NOT NULL DEFAULT 'A';
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "isFrozen" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "thumbnailKey" TEXT;

-- Add revision to file_versions
ALTER TABLE "file_versions" ADD COLUMN IF NOT EXISTS "revision" TEXT NOT NULL DEFAULT 'A';

-- BOM tables
CREATE TABLE "boms" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "revision" TEXT NOT NULL DEFAULT 'A',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "boms_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "boms_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
    CONSTRAINT "boms_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE CASCADE,
    CONSTRAINT "boms_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "tenant_users"("id")
);

CREATE INDEX "boms_tenantId_idx" ON "boms"("tenantId");
CREATE INDEX "boms_fileId_idx" ON "boms"("fileId");

CREATE TABLE "bom_items" (
    "id" TEXT NOT NULL,
    "bomId" TEXT NOT NULL,
    "fileId" TEXT,
    "itemNumber" TEXT NOT NULL,
    "partNumber" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "unit" TEXT NOT NULL DEFAULT 'EA',
    "level" INTEGER NOT NULL DEFAULT 1,
    "parentItemId" TEXT,
    "material" TEXT,
    "vendor" TEXT,
    "unitCost" DOUBLE PRECISION,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "bom_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "bom_items_bomId_fkey" FOREIGN KEY ("bomId") REFERENCES "boms"("id") ON DELETE CASCADE,
    CONSTRAINT "bom_items_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE SET NULL,
    CONSTRAINT "bom_items_parentItemId_fkey" FOREIGN KEY ("parentItemId") REFERENCES "bom_items"("id") ON DELETE SET NULL
);

CREATE INDEX "bom_items_bomId_idx" ON "bom_items"("bomId");

-- Folder permissions
CREATE TABLE "folder_permissions" (
    "id" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "userId" TEXT,
    "roleId" TEXT,
    "access" TEXT NOT NULL DEFAULT 'VIEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "folder_permissions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "folder_permissions_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "folders"("id") ON DELETE CASCADE,
    CONSTRAINT "folder_permissions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "tenant_users"("id") ON DELETE CASCADE,
    CONSTRAINT "folder_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE
);

CREATE INDEX "folder_permissions_folderId_idx" ON "folder_permissions"("folderId");

-- Notifications
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'system',
    "link" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notifications_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
    CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "tenant_users"("id") ON DELETE CASCADE
);

CREATE INDEX "notifications_userId_isRead_idx" ON "notifications"("userId", "isRead");

-- Make roles fully editable (add canDelete flag to distinguish system from custom)
ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "canEdit" BOOLEAN NOT NULL DEFAULT true;
UPDATE "roles" SET "canEdit" = false WHERE "isSystem" = true;

-- Saved searches
CREATE TABLE "saved_searches" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "isShared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "saved_searches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "saved_searches_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
    CONSTRAINT "saved_searches_userId_fkey" FOREIGN KEY ("userId") REFERENCES "tenant_users"("id") ON DELETE CASCADE
);
