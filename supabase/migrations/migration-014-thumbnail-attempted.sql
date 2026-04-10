-- PACE PDM Migration 014: Negative-cache thumbnail extraction attempts
--
-- Without this column, the files list endpoint re-runs the thumbnail
-- extractor on every refresh for any file missing `thumbnailKey` — which
-- means files whose extraction *legitimately* returns null (e.g. a
-- SolidWorks file saved without "Save preview picture", an EMF-only
-- preview) get downloaded and reprocessed on every folder view forever.
--
-- `thumbnailAttemptedAt` is set after any extraction attempt, success or
-- failure. The list backfill skips files where it's set. The manual
-- "Regenerate thumbnail" action in the detail panel ignores the flag so
-- users can still force a retry after re-saving a file with its preview
-- enabled.
--
-- Per project convention, run this in the Supabase SQL Editor (not
-- `prisma migrate`). All statements are idempotent — safe to re-run.

ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "thumbnailAttemptedAt" TIMESTAMP(3);

-- Backfill existing rows: any file that already has a thumbnailKey has
-- obviously been attempted successfully, so stamp it with its updatedAt
-- to keep the semantics consistent (first attempt = when the file was
-- last processed). Rows without a thumbnailKey stay NULL and will be
-- picked up on the next folder view.
UPDATE "files"
SET "thumbnailAttemptedAt" = "updatedAt"
WHERE "thumbnailKey" IS NOT NULL
  AND "thumbnailAttemptedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "files_thumbnail_backfill_idx"
  ON "files" ("tenantId", "thumbnailAttemptedAt")
  WHERE "thumbnailKey" IS NULL;
