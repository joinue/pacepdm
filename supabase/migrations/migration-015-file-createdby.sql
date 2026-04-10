-- PACE PDM Migration 015: File createdById
--
-- Adds a `createdById` column to `files` so we can target notifications
-- (lifecycle transitions, ECO implementations) at the person who
-- originally uploaded a file rather than broadcasting to the whole
-- tenant. Nullable because historical rows may predate this migration
-- and the uploader may have been removed.
--
-- Backfills from `file_versions`: the earliest version's uploader is
-- treated as the file's creator. Rows with no version history stay NULL.
--
-- Per project convention, run this in the Supabase SQL Editor (not
-- `prisma migrate`). All statements are idempotent — safe to re-run.

ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "createdById" TEXT;

-- Backfill from earliest file_version.uploadedById. DISTINCT ON picks the
-- oldest row per fileId; only touches rows that are still NULL so re-runs
-- don't overwrite values already set by the app.
UPDATE "files" f
SET "createdById" = fv."uploadedById"
FROM (
  SELECT DISTINCT ON ("fileId") "fileId", "uploadedById"
  FROM "file_versions"
  ORDER BY "fileId", "createdAt" ASC
) fv
WHERE fv."fileId" = f."id" AND f."createdById" IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'files_createdById_fkey' AND table_name = 'files'
  ) THEN
    ALTER TABLE "files" ADD CONSTRAINT "files_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "tenant_users"("id") ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "files_createdById_idx"
  ON "files" ("tenantId", "createdById");
