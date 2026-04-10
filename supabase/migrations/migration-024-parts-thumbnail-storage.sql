-- PACE PDM Migration 024: Move part thumbnails from inline data URLs to Supabase Storage.
--
-- Background
-- ──────────
-- The original `parts.thumbnailUrl` column was a TEXT field that the frontend
-- populated with a base64 `data:image/...;base64,...` URL via a JSON PUT.
-- Convenient, but it bloats `parts` rows by hundreds of KB each, kills the
-- query planner's row-estimation, and pulls every thumbnail into memory on
-- any plain `SELECT * FROM parts`. The `files` module already has a clean
-- pattern: store the storage object key on the row, generate a signed URL
-- on read. This migration moves `parts` onto the same pattern.
--
-- What this migration does
-- ────────────────────────
-- 1. Adds `parts.thumbnailKey` (TEXT, nullable) — the storage object path
--    inside the "vault" bucket, e.g.
--    `{tenantId}/thumbnails/parts/{partId}-{ts}.png`. Mirrors `files.thumbnailKey`.
-- 2. Drops `parts.thumbnailUrl`. Any existing inline data URLs are discarded.
--    The project is pre-production and the data is trivial (small previews
--    from the dev tenant), so a hard drop is fine. If you need to preserve
--    them, run a backfill *before* applying this migration.
--
-- Storage objects
-- ───────────────
-- This migration does NOT create the "vault" bucket — it already exists
-- (used by the files module). Object writes happen from server routes via
-- service_role, which bypasses storage RLS. No new storage policies are
-- needed for now; if browser-side reads of part thumbnails are ever added,
-- mirror the file thumbnail policy at that point.
--
-- Idempotency
-- ───────────
-- ADD COLUMN IF NOT EXISTS / DROP COLUMN IF EXISTS — safe to re-run.

ALTER TABLE "parts" ADD COLUMN IF NOT EXISTS "thumbnailKey" TEXT;

ALTER TABLE "parts" DROP COLUMN IF EXISTS "thumbnailUrl";
