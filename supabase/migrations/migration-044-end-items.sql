-- PACE PDM Migration 044: end items, and tying a BOM to the item it describes
--
-- Separates two facts the app has been conflating: where a BOM sits in the
-- structure, and whether the thing it describes is something you sell.
--
-- The BOM list derives nesting from `bom_items.linkedBomId` and labels the
-- unreferenced BOMs "Products". Deriving the nesting is right — it cannot
-- drift from the real structure. Calling the result "products" is not: that
-- is a commercial fact, and no arrangement of parent/child rows can tell you
-- it. Two things break on it immediately:
--
--   * a draft BOM nobody has linked yet shows as a product;
--   * a sub-assembly you also sell as a spare is buried inside its parent
--     and appears nowhere as a product.
--
-- Every serious PDM/PLM keeps these apart. Windchill has an End Item
-- designation on a part that says nothing about its position in any
-- structure; NetSuite has assembly items with BOMs and "Available for Sale"
-- as an independent flag; Teamcenter items appear at any level of any BOM
-- view without a marker. Structure is derived, designation is declared.
--
-- ── 1. `parts.isEndItem` ────────────────────────────────────────────────
--
-- On PARTS, not on BOMS, and that placement is the whole point. PACE already
-- has a sellable item with no bill of materials at all: PW-1000A and PW-800A
-- are the polishing wheels sold separately with the NANO-1000S, and they are
-- option lines on a BOM rather than assemblies of their own. A flag on
-- `boms` could not express them. A flag on the item can, and it maps
-- directly onto NetSuite's own field when the ERP push is built.
--
-- ── 2. `boms.partId` ────────────────────────────────────────────────────
--
-- For `isEndItem` to reach the BOM list, a BOM has to know which item it
-- describes. Today it does not: `boms` carries a free-text `name` and an
-- optional `fileId`, and the importer's convention that a BOM's name equals
-- its part's number is exactly that — a convention, invisible to the schema
-- and one rename away from silently breaking.
--
-- In Windchill and Teamcenter a bill of materials is not a free-standing
-- object at all; it is the structure OF an item. `boms.partId` moves PACE
-- toward that without forcing it: the column is nullable, so a hand-made
-- BOM that has no part yet still works, it just cannot be designated an end
-- item until it has one.
--
-- ON DELETE SET NULL, matching migration 035: removing a part must not
-- cascade into deleting BOMs.
--
-- Re-runnable. The backfill only fills nulls, so running it twice is a
-- no-op and it never overwrites a link made by hand.

ALTER TABLE "parts" ADD COLUMN IF NOT EXISTS "isEndItem" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "boms" ADD COLUMN IF NOT EXISTS "partId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boms_partId_fkey') THEN
    ALTER TABLE "boms"
      ADD CONSTRAINT "boms_partId_fkey"
      FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "boms_partId_idx" ON "boms" ("partId");

-- End items are a small minority of parts and are read on every BOM list.
CREATE INDEX IF NOT EXISTS "parts_tenantId_end_item_idx"
  ON "parts" ("tenantId") WHERE "isEndItem" = TRUE;

-- ── Backfill ────────────────────────────────────────────────────────────
--
-- Adopt the importer's existing convention once, explicitly, so it stops
-- being a convention: link every BOM to the part sharing its name. Only
-- fills nulls, and only where the match is unambiguous within the tenant.

UPDATE "boms" b
   SET "partId" = p."id"
  FROM "parts" p
 WHERE b."partId" IS NULL
   AND p."tenantId" = b."tenantId"
   AND p."partNumber" = b."name"
   AND p."deletedAt" IS NULL;

-- Nothing is marked an end item by the migration. Designation is a decision
-- a person makes, and guessing it from structure is the mistake this
-- migration exists to correct.

-- ── Verification ────────────────────────────────────────────────────────
--
--   select count(*) filter (where "partId" is null) as unlinked,
--          count(*) as total
--     from boms where "deletedAt" is null;
--   -- after the NANO-1000S import: unlinked 0, total 26
--
--   select column_name from information_schema.columns
--    where table_name = 'parts' and column_name = 'isEndItem';
--
-- RLS: no new tables, so policies are unchanged (migrations 023 and 039).
