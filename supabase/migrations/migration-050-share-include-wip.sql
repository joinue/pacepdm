-- PACE PDM Migration 050: part shares can deliberately include work in progress
--
-- Migration 048 added part shares, and `buildPartPackage` filters them to
-- `lifecycleState = 'Released'` so a supplier cannot be sent a half-finished
-- drawing to quote or cut metal from.
--
-- That default is right and stays. But it assumes a release process is
-- running, and at PACE one is not yet: every file in the vault is WIP, so a
-- part share resolves to an empty package and sourcing cannot get a quote at
-- all. The realistic workflow is that an engineer finishes a drawing and
-- sourcing wants a price before it has been formally released.
--
-- So: an explicit, per-link opt-in, rather than relaxing the default for
-- everyone.
--
--   * Defaults to FALSE. A link created without thinking about it behaves
--     exactly as it did before this migration.
--   * When TRUE, unreleased documents are included AND the public viewer
--     labels each one PRELIMINARY — NOT FOR PRODUCTION, and the zip prefixes
--     their filenames. The stamp is the point; without it this is just a
--     hole in the filter.
--   * It is persisted on the token rather than passed per request, so the
--     audit trail can answer "was this supplier sent preliminary drawings,
--     and who decided that" months later. `share.create` records it too.
--
-- Why not a permission instead: the decision is per-link, not per-person.
-- The same sourcing user legitimately sends released packages most of the
-- time and a preliminary one when chasing a quote, and a permission cannot
-- express "this particular link".
--
-- Re-runnable. No new table, so the migration-039 RLS posture is unchanged.

ALTER TABLE "share_tokens"
  ADD COLUMN IF NOT EXISTS "includeWip" boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN "share_tokens"."includeWip" IS
  'Part shares only. When true the package includes non-Released files and the viewer stamps them PRELIMINARY. Defaults false; see docs/decisions/supplier-access.md.';

-- Existing rows take the default, which preserves current behaviour for
-- every link already in circulation.

NOTIFY pgrst, 'reload schema';
