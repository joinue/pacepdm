-- PACE PDM Migration 035: allow tenant_user deletion by relaxing FKs to SET NULL
--
-- Several foreign keys referencing tenant_users use RESTRICT or NO ACTION,
-- which prevents deleting a user who has ever created a file version, BOM,
-- ECO, part, or approval decision. This migration changes those to SET NULL
-- so the data survives (with a null creator) and the user row can be removed.
--
-- Tables already using SET NULL or CASCADE are left untouched.

-- file_versions.uploadedById: RESTRICT → SET NULL
-- The column was NOT NULL — must drop that first or SET NULL triggers a constraint violation.
ALTER TABLE "file_versions" ALTER COLUMN "uploadedById" DROP NOT NULL;
ALTER TABLE "file_versions" DROP CONSTRAINT "file_versions_uploadedById_fkey";
ALTER TABLE "file_versions"
  ADD CONSTRAINT "file_versions_uploadedById_fkey"
  FOREIGN KEY ("uploadedById") REFERENCES "tenant_users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- boms.createdById: NO ACTION → SET NULL
ALTER TABLE "boms" ALTER COLUMN "createdById" DROP NOT NULL;
ALTER TABLE "boms" DROP CONSTRAINT "boms_createdById_fkey";
ALTER TABLE "boms"
  ADD CONSTRAINT "boms_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "tenant_users"("id")
  ON DELETE SET NULL;

-- ecos.createdById: NO ACTION → SET NULL
ALTER TABLE "ecos" ALTER COLUMN "createdById" DROP NOT NULL;
ALTER TABLE "ecos" DROP CONSTRAINT "ecos_createdById_fkey";
ALTER TABLE "ecos"
  ADD CONSTRAINT "ecos_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "tenant_users"("id")
  ON DELETE SET NULL;

-- ecos.implementedById: NO ACTION → SET NULL
ALTER TABLE "ecos" DROP CONSTRAINT "ecos_implementedById_fkey";
ALTER TABLE "ecos"
  ADD CONSTRAINT "ecos_implementedById_fkey"
  FOREIGN KEY ("implementedById") REFERENCES "tenant_users"("id")
  ON DELETE SET NULL;

-- approval_requests.requestedById: NO ACTION → SET NULL
ALTER TABLE "approval_requests" ALTER COLUMN "requestedById" DROP NOT NULL;
ALTER TABLE "approval_requests" DROP CONSTRAINT "approval_requests_requestedById_fkey";
ALTER TABLE "approval_requests"
  ADD CONSTRAINT "approval_requests_requestedById_fkey"
  FOREIGN KEY ("requestedById") REFERENCES "tenant_users"("id")
  ON DELETE SET NULL;

-- approval_decisions.deciderId: NO ACTION → SET NULL
ALTER TABLE "approval_decisions" DROP CONSTRAINT "approval_decisions_deciderId_fkey";
ALTER TABLE "approval_decisions"
  ADD CONSTRAINT "approval_decisions_deciderId_fkey"
  FOREIGN KEY ("deciderId") REFERENCES "tenant_users"("id")
  ON DELETE SET NULL;

-- parts.createdById: NO ACTION → SET NULL
ALTER TABLE "parts" ALTER COLUMN "createdById" DROP NOT NULL;
ALTER TABLE "parts" DROP CONSTRAINT "parts_createdById_fkey";
ALTER TABLE "parts"
  ADD CONSTRAINT "parts_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "tenant_users"("id")
  ON DELETE SET NULL;

-- bom_baselines.createdById: implicit NO ACTION → SET NULL
-- The column was added in migration-027 with a bare REFERENCES clause.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'bom_baselines_createdById_fkey'
  ) THEN
    ALTER TABLE "bom_baselines" DROP CONSTRAINT "bom_baselines_createdById_fkey";
    ALTER TABLE "bom_baselines"
      ADD CONSTRAINT "bom_baselines_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "tenant_users"("id")
      ON DELETE SET NULL;
  END IF;
END $$;
