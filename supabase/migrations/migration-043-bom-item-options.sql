-- PACE PDM Migration 043: configure-to-order options on BOM lines
--
-- Enables the BOM importer (`POST /api/boms/import`) to represent PACE's
-- configure-to-order product structure without lying about quantities.
--
-- The NANO-1000S build list carries option groups: "Voltage" offers
-- C-110V-001 / C-220V-002 / C-220V-003 / C-220V-004, "Bowl size" offers
-- PW-1000A / PW-800A, and so on for "Fuse" and "Paper ring size". A given
-- machine ships with exactly ONE member of each group.
--
-- Without somewhere to record that, the importer had three bad choices:
-- drop those lines (10 real parts vanish from the BOM of record), import
-- them flat (the NANO-1000S BOM then contains both 110V and 220V parts and
-- both bowl sizes, so the cost rollup overstates and the BOM is not a
-- buildable list), or invent a convention in a name string. Two nullable
-- columns are cheaper than any of those.
--
--   optionGroup   — the group a line belongs to ("Voltage"). NULL for the
--                   ordinary always-included lines, which is almost all of
--                   them: 10 of 135 rows in the NANO-1000S file are options.
--   optionPrompt  — the question asked at order entry ("What Voltage
--                   ordered"). Purely descriptive; carried through so the
--                   information is not lost on the way in.
--
-- Lines with a non-NULL optionGroup are excluded from base-configuration
-- rollup totals in `src/lib/bom-rollup.ts` and surfaced separately, so
-- "what does the base machine cost" and "what can be configured" are both
-- answerable from the same BOM.
--
-- Deliberately NOT modelled here: which option is the default, and mutual
-- exclusivity as a constraint. The source file sets IsGroupDefault = TRUE
-- on every row including all alternates, so it carries no usable default,
-- and enforcing "exactly one per group" belongs in a configurator PACE does
-- not have. These columns record what the source knows; they do not claim
-- to be a configurator.
--
-- `bom_items` has no tenantId — it is reached only through its parent BOM,
-- which is scoped (see the child-table note in AGENTS.md). RLS is unchanged:
-- the table already has it enabled from migration 039, and no new table is
-- created here.
--
-- Re-runnable.

ALTER TABLE "bom_items" ADD COLUMN IF NOT EXISTS "optionGroup" TEXT;
ALTER TABLE "bom_items" ADD COLUMN IF NOT EXISTS "optionPrompt" TEXT;

-- Rollup and the BOM detail view both partition on this, and options are a
-- small minority of rows, so a partial index is the right shape.
CREATE INDEX IF NOT EXISTS "bom_items_bomId_option_idx"
  ON "bom_items" ("bomId", "optionGroup")
  WHERE "optionGroup" IS NOT NULL;

-- ── Verification ─────────────────────────────────────────────────────────
--
--   select column_name from information_schema.columns
--    where table_name = 'bom_items'
--      and column_name in ('optionGroup', 'optionPrompt');
--   -- expect 2 rows
--
-- After importing the NANO-1000S build list, expect 10 option rows across
-- 4 distinct groups:
--
--   select "optionGroup", count(*) from bom_items
--    where "optionGroup" is not null group by 1 order by 1;
--   -- Bowl size 2 | Fuse 2 | Paper ring size 2 | Voltage 4
