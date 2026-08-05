-- PACE PDM Migration 048: share links can target a part
--
-- What this closes:
--
-- Share links target a file, a BOM, or a release (migrations 030 and 033).
-- None of those is the thing sourcing actually sends a supplier. A supplier
-- asks for "N1S-M-001 rev R2" — the part — and expects its drawing, its
-- model and its spec together. Today that means minting one link per file
-- by hand, with nothing guaranteeing the set is complete or current, and
-- nothing recording that the set went out as a unit.
--
-- `resourceType` is polymorphic with no FK (see migration 030's notes), so
-- the only schema change needed is widening the two CHECK constraints. The
-- application resolves the part, gathers its released files, and streams
-- them as one zip — see src/lib/part-package.ts.
--
-- Why a part share is deliberately NOT a file share pointed at several
-- files: the package is resolved at *view* time, not at *mint* time. A
-- supplier who bookmarks the link and comes back after an ECO ships sees
-- the new revision, because that is the entire point of the feature. A set
-- of file links frozen at mint time would go stale silently, which is the
-- failure mode this replaces.
--
-- Verified before writing: both constraints exist with the migration-033
-- three-value form ('file', 'bom', 'release'), so this widens rather than
-- creates. Re-runnable — both constraints are dropped by name first.

-- ── share_tokens ─────────────────────────────────────────────────────────

ALTER TABLE "share_tokens"
  DROP CONSTRAINT IF EXISTS "share_tokens_resourceType_check";

ALTER TABLE "share_tokens"
  ADD CONSTRAINT "share_tokens_resourceType_check"
  CHECK ("resourceType" IN ('file', 'bom', 'release', 'part'));

-- ── share_token_access ───────────────────────────────────────────────────
--
-- The access log mirrors the token's resourceType (migration 037). It must
-- widen in the same migration or every logged hit on a part share fails the
-- CHECK and the insert is lost — and because logShareAccess is void-called
-- as a side effect, that loss would be silent.

ALTER TABLE "share_token_access"
  DROP CONSTRAINT IF EXISTS "share_token_access_resourceType_check";

ALTER TABLE "share_token_access"
  ADD CONSTRAINT "share_token_access_resourceType_check"
  CHECK ("resourceType" IN ('file', 'bom', 'release', 'part'));

-- ── RLS ──────────────────────────────────────────────────────────────────
--
-- No new table, so the migration-039 lockdown posture is unchanged. Both
-- tables keep RLS enabled with no policies: they are reached only through
-- server code holding the service role. `npm run probe:rls` already covers
-- them and needs no new entry.
