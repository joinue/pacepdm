-- PACE PDM Migration 004: BOM Improvements
-- Run this in Supabase SQL Editor

-- Make boms.fileId nullable (BOMs can exist without a linked file)
ALTER TABLE "boms" ALTER COLUMN "fileId" DROP NOT NULL;

-- Drop the CASCADE delete — deleting a file should NOT delete the BOM
ALTER TABLE "boms" DROP CONSTRAINT IF EXISTS "boms_fileId_fkey";
ALTER TABLE "boms" ADD CONSTRAINT "boms_fileId_fkey"
  FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE SET NULL;
