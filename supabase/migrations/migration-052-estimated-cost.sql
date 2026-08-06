-- PACE PDM Migration 052: separate the engineering estimate from the real cost
--
-- Adds `parts.estimatedCost`. `parts.unitCost` stays and changes meaning: it
-- becomes the authoritative figure, which an admin can lock so only a source of
-- truth writes it.
--
-- Why two fields rather than one relabelled one
-- ─────────────────────────────────────────────
--
-- The earlier plan was to relabel `unitCost` as an estimate and leave it at
-- that. That works for a tenant with NetSuite and fails everyone else: a team
-- with no ERP has no other place to record what a part actually costs, so
-- calling their only cost field an estimate makes it useless to them.
--
-- Two fields serve both. An engineer always has somewhere to put a guess. A
-- tenant with a source of cost truth locks `unitCost` so nothing but that
-- source writes it. A tenant without one leaves it open and it is simply their
-- cost. Controlled by the `costSource` tenant setting — "OPEN" (default) or
-- "LOCKED" — so it changes with a toggle and not a migration.
--
-- Direction of travel matters here and is recorded in
-- docs/decisions/erp-ownership.md: NetSuite → PACE is the goal, because pulling
-- real cost down is what turns a rollup from an estimate into a number worth
-- quoting. PACE → NetSuite never carries cost. An estimate typed into a form
-- must not be able to overwrite what Finance believes, and the two fields look
-- identical on the wire, which is exactly why they are not one field.
--
-- What this does NOT change
-- ─────────────────────────
--
-- `bom_items.unitCost` is untouched. A line-level override is a judgement about
-- one use of a part rather than about the part, so it is an estimate by nature
-- and gets no split of its own. Giving it one would produce four numbers per
-- line and no way to reason about which the rollup used.
--
-- Numeric, matching `unitCost`, so the two are directly comparable and neither
-- carries its own currency — `parts.currency` still applies to both.
--
-- Verified before writing: `parts` has `unitCost numeric` and `currency text`,
-- and no `estimatedCost` column is referenced anywhere in src.
--
-- Idempotent and re-runnable, per docs/decisions/hand-applied-migrations.md.
-- No new tables, so the RLS posture is unchanged.

alter table parts
  add column if not exists "estimatedCost" numeric;

comment on column parts."estimatedCost" is
  'Engineering estimate of unit cost. Always writable regardless of the '
  'costSource setting. Never authoritative, never pushed to an ERP. The '
  'rollup falls back to this when unitCost is null, and reports how many '
  'lines it had to.';

comment on column parts."unitCost" is
  'Authoritative unit cost. Writable by anyone while the tenant setting '
  'costSource is OPEN; read-only once it is LOCKED, so only an ERP sync '
  'populates it. See docs/decisions/erp-ownership.md.';

-- ── Verify ──────────────────────────────────────────────────────────────────
--
-- Paste after running. Expect both columns, numeric and nullable.
--
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_name = 'parts'
--      and column_name in ('unitCost', 'estimatedCost');
