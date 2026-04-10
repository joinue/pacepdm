-- PACE PDM Migration 020: BOM items as live links to parts
--
-- Today every `bom_items` row carries a denormalized snapshot of the
-- linked part — `name`, `partNumber`, `material`, `unitCost`, etc. are
-- copied into the row at insert time. That was fine when BOMs rarely
-- changed, but it means renaming a part or bumping its revision leaves
-- every existing BOM showing stale data.
--
-- The real fix is in the application layer: the BOM items GET endpoint
-- now joins `parts` and the `bom-items-table.tsx` component prefers the
-- live part fields (via `displayOf(item)`) over the snapshot columns.
-- The snapshot stays as a fallback for two cases:
--
--   1. Free-text items (no `partId`) — the row is the only source of
--      truth for those fields and `name` must stay populated.
--   2. Rows whose `partId` was later SET NULL by part deletion — the
--      snapshot keeps the line meaningful instead of becoming a ghost.
--
-- This migration is a small schema loosening so the app CAN, in the
-- future, insert a pure-link row (just `{partId, itemNumber, quantity}`)
-- without having to copy-paste snapshot text that's about to be
-- overridden by the live join anyway. Two changes:
--
--   1. `bom_items.name` becomes nullable. The current API still fills
--      it via the snapshot path in `fetchPartSnapshots`, so no existing
--      insert site breaks — this is purely permissive.
--
--   2. A CHECK constraint guarantees every row still resolves to
--      *something* — either a name (free-text or snapshot) or at least
--      one structural link (partId / fileId / linkedBomId). This
--      replaces the old NOT NULL guarantee with a weaker but more
--      accurate rule: "a BOM line must identify what it refers to."
--
-- Run this in the Supabase SQL Editor. All statements are idempotent.

-- ─── 1. Loosen NOT NULL on bom_items.name ────────────────────────────────

ALTER TABLE "bom_items" ALTER COLUMN "name" DROP NOT NULL;

-- ─── 2. CHECK: every row must identify its target ────────────────────────
--
-- At least one of the following must be true:
--   - the row has a human name (free-text item or snapshot-filled), OR
--   - the row links to a part, a file, or a sub-assembly BOM.
--
-- A row with nothing set is a bug — it would render as a blank line
-- with no way to click through.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'bom_items_target_present'
      AND table_name = 'bom_items'
  ) THEN
    ALTER TABLE "bom_items"
      ADD CONSTRAINT "bom_items_target_present"
      CHECK (
        "name" IS NOT NULL
        OR "partId" IS NOT NULL
        OR "fileId" IS NOT NULL
        OR "linkedBomId" IS NOT NULL
      );
  END IF;
END $$;
