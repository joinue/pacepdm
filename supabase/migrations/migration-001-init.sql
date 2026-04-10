-- PACE PDM Schema Migration
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor > New Query)

-- CreateEnum
CREATE TYPE "FileCategory" AS ENUM ('PART', 'ASSEMBLY', 'DRAWING', 'DOCUMENT', 'PURCHASED', 'OTHER');

-- CreateEnum
CREATE TYPE "MetadataType" AS ENUM ('TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT', 'URL');

-- CreateEnum
CREATE TYPE "ECOStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'IMPLEMENTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ECOPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_users" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "authUserId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tenant_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" JSONB NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folders" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "path" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "files" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "partNumber" TEXT,
    "description" TEXT,
    "fileType" TEXT NOT NULL,
    "category" "FileCategory" NOT NULL DEFAULT 'DOCUMENT',
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "lifecycleState" TEXT NOT NULL DEFAULT 'WIP',
    "lifecycleId" TEXT,
    "isCheckedOut" BOOLEAN NOT NULL DEFAULT false,
    "checkedOutById" TEXT,
    "checkedOutAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_versions" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "checksum" TEXT,
    "uploadedById" TEXT NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "file_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_references" (
    "id" TEXT NOT NULL,
    "sourceFileId" TEXT NOT NULL,
    "targetFileId" TEXT NOT NULL,
    "referenceType" TEXT NOT NULL DEFAULT 'contains',
    CONSTRAINT "file_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metadata_fields" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fieldType" "MetadataType" NOT NULL DEFAULT 'TEXT',
    "options" JSONB,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "appliesTo" "FileCategory"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "metadata_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metadata_values" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    CONSTRAINT "metadata_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lifecycles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "lifecycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lifecycle_states" (
    "id" TEXT NOT NULL,
    "lifecycleId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6B7280',
    "isInitial" BOOLEAN NOT NULL DEFAULT false,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "lifecycle_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lifecycle_transitions" (
    "id" TEXT NOT NULL,
    "lifecycleId" TEXT NOT NULL,
    "fromStateId" TEXT NOT NULL,
    "toStateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "approvalRoles" JSONB,
    CONSTRAINT "lifecycle_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ecos" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ecoNumber" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "ECOStatus" NOT NULL DEFAULT 'DRAFT',
    "priority" "ECOPriority" NOT NULL DEFAULT 'MEDIUM',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ecos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eco_items" (
    "id" TEXT NOT NULL,
    "ecoId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "changeType" TEXT NOT NULL,
    "reason" TEXT,
    CONSTRAINT "eco_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" TEXT NOT NULL,
    "ecoId" TEXT NOT NULL,
    "approverId" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "comment" TEXT,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "details" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");
CREATE UNIQUE INDEX "tenant_users_tenantId_authUserId_key" ON "tenant_users"("tenantId", "authUserId");
CREATE UNIQUE INDEX "tenant_users_tenantId_email_key" ON "tenant_users"("tenantId", "email");
CREATE UNIQUE INDEX "roles_tenantId_name_key" ON "roles"("tenantId", "name");
CREATE UNIQUE INDEX "folders_tenantId_path_key" ON "folders"("tenantId", "path");
CREATE UNIQUE INDEX "files_tenantId_folderId_name_key" ON "files"("tenantId", "folderId", "name");
CREATE UNIQUE INDEX "file_versions_fileId_version_key" ON "file_versions"("fileId", "version");
CREATE UNIQUE INDEX "file_references_sourceFileId_targetFileId_referenceType_key" ON "file_references"("sourceFileId", "targetFileId", "referenceType");
CREATE UNIQUE INDEX "metadata_fields_tenantId_name_key" ON "metadata_fields"("tenantId", "name");
CREATE UNIQUE INDEX "metadata_values_fileId_fieldId_key" ON "metadata_values"("fileId", "fieldId");
CREATE UNIQUE INDEX "lifecycles_tenantId_name_key" ON "lifecycles"("tenantId", "name");
CREATE UNIQUE INDEX "lifecycle_states_lifecycleId_name_key" ON "lifecycle_states"("lifecycleId", "name");
CREATE UNIQUE INDEX "ecos_tenantId_ecoNumber_key" ON "ecos"("tenantId", "ecoNumber");
CREATE INDEX "audit_logs_tenantId_entityType_entityId_idx" ON "audit_logs"("tenantId", "entityType", "entityId");
CREATE INDEX "audit_logs_tenantId_createdAt_idx" ON "audit_logs"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "tenant_users" ADD CONSTRAINT "tenant_users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_users" ADD CONSTRAINT "tenant_users_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "folders" ADD CONSTRAINT "folders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "folders" ADD CONSTRAINT "folders_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "files" ADD CONSTRAINT "files_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "files" ADD CONSTRAINT "files_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "folders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "files" ADD CONSTRAINT "files_lifecycleId_fkey" FOREIGN KEY ("lifecycleId") REFERENCES "lifecycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "files" ADD CONSTRAINT "files_checkedOutById_fkey" FOREIGN KEY ("checkedOutById") REFERENCES "tenant_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "tenant_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "file_references" ADD CONSTRAINT "file_references_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "file_references" ADD CONSTRAINT "file_references_targetFileId_fkey" FOREIGN KEY ("targetFileId") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "metadata_fields" ADD CONSTRAINT "metadata_fields_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "metadata_values" ADD CONSTRAINT "metadata_values_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "metadata_values" ADD CONSTRAINT "metadata_values_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "metadata_fields"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lifecycles" ADD CONSTRAINT "lifecycles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lifecycle_states" ADD CONSTRAINT "lifecycle_states_lifecycleId_fkey" FOREIGN KEY ("lifecycleId") REFERENCES "lifecycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lifecycle_transitions" ADD CONSTRAINT "lifecycle_transitions_lifecycleId_fkey" FOREIGN KEY ("lifecycleId") REFERENCES "lifecycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lifecycle_transitions" ADD CONSTRAINT "lifecycle_transitions_fromStateId_fkey" FOREIGN KEY ("fromStateId") REFERENCES "lifecycle_states"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lifecycle_transitions" ADD CONSTRAINT "lifecycle_transitions_toStateId_fkey" FOREIGN KEY ("toStateId") REFERENCES "lifecycle_states"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ecos" ADD CONSTRAINT "ecos_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "eco_items" ADD CONSTRAINT "eco_items_ecoId_fkey" FOREIGN KEY ("ecoId") REFERENCES "ecos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "eco_items" ADD CONSTRAINT "eco_items_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_ecoId_fkey" FOREIGN KEY ("ecoId") REFERENCES "ecos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "tenant_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "tenant_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
