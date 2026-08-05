-- PACE PDM Migration 042: make soft-deleted files recoverable
--
-- Deletes have been soft since migration 036 — `files.deletedAt` is stamped
-- and the row and its storage blob both survive — but nothing in the app
-- could reach a deleted row. Three files had to be recovered by hand with
-- SQL in August 2026. This migration is the schema half of the trash view
-- and `POST /api/files/[fileId]/undelete`.
--
-- Two changes, and the second one also fixes a live bug.
--
-- 1. `deletedById`. `deletedAt` records when but not who. The audit log has
--    it (`action = 'file.delete'`), but joining the audit trail to render a
--    list is the wrong shape for a hot path, and audit rows are append-only
--    for a different purpose. ON DELETE SET NULL matches the convention
--    migration 035 established for the other actor columns: removing a user
--    must not cascade into deleting their history.
--
-- 2. `files_tenantId_folderId_name_key` becomes partial on
--    `"deletedAt" IS NULL`.
--
--    The index from migration 001 covers every row including soft-deleted
--    ones, which means a deleted file keeps occupying its name slot forever.
--    Observable today, without any of the new code: delete `bracket.sldprt`,
--    then upload a new `bracket.sldprt` to the same folder. The upload
--    route's pre-check queries `.is("deletedAt", null)`, finds nothing, and
--    proceeds — then the insert hits 23505 and the user is told "A file with
--    this name already exists in this folder" about a file that is not
--    visible anywhere in the UI.
--
--    Making the index partial fixes that, and is also what makes a trash
--    view coherent: a name in the trash should not reserve anything.
--
--    The tradeoff is that undelete can now find its old name taken. That is
--    handled in the route with a 409 explaining which file holds the name,
--    rather than by silently renaming the restored file — a file that comes
--    back under a different name than it had is worse than one that refuses
--    to come back until you say what you want.
--
-- Verified before writing: the live index is non-partial (indexdef has no
-- WHERE clause), and files.deletedById does not exist.
--
--   select indexdef from pg_indexes
--    where indexname = 'files_tenantId_folderId_name_key';
--
-- Re-runnable. Dropping and recreating the unique index is not atomic, so
-- there is a window where duplicate active names could be inserted; at this
-- scale, on a hand-applied migration, that is acceptable. Do not run it
-- against a busy database without taking the write path down first.

-- ── 1. Who deleted it ────────────────────────────────────────────────────

ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "deletedById" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'files_deletedById_fkey'
  ) THEN
    ALTER TABLE "files"
      ADD CONSTRAINT "files_deletedById_fkey"
      FOREIGN KEY ("deletedById") REFERENCES "tenant_users"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- Supports the trash listing, which orders by deletion time within a tenant.
CREATE INDEX IF NOT EXISTS "files_tenantId_deleted_idx"
  ON "files" ("tenantId", "deletedAt" DESC)
  WHERE "deletedAt" IS NOT NULL;

-- ── 2. Free the name slot when a file is deleted ─────────────────────────

DROP INDEX IF EXISTS "files_tenantId_folderId_name_key";

CREATE UNIQUE INDEX IF NOT EXISTS "files_tenantId_folderId_name_key"
  ON "files" ("tenantId", "folderId", "name")
  WHERE "deletedAt" IS NULL;

-- ── Verification ─────────────────────────────────────────────────────────
--
-- Expect the index to report a WHERE clause, and the column to exist:
--
--   select indexdef from pg_indexes
--    where indexname = 'files_tenantId_folderId_name_key';
--   -- ... WHERE ("deletedAt" IS NULL)
--
--   select column_name from information_schema.columns
--    where table_name = 'files' and column_name = 'deletedById';
--
-- RLS: `files` already has RLS enabled (migration 023, reaffirmed by 039).
-- No new table is created here, so no policy work is needed.
