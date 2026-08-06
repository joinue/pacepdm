-- PACE PDM Migration 051: ERP external identifier on parts and boms
--
-- Adds a nullable `externalId` to `parts` and `boms`, unique per tenant when
-- set. Nothing writes it yet. This is deliberately ahead of the integration:
-- adding the column now costs one migration, and adding it after a few hundred
-- parts are entered costs a reconciliation project against records that have no
-- stable link to their NetSuite counterparts.
--
-- Why a column rather than matching on part number
-- ───────────────────────────────────────────────
--
-- Any sync without one keys on `partNumber` string matching, which breaks the
-- first time somebody corrects a part number — and it is already broken here,
-- before anyone has edited anything.
--
-- The archive bakes the revision into the part number (`N1S-M-001-R2`,
-- `N1S-SA-A-R4`, 14 of them). The BOM importer splits those, so PACE holds part
-- `N1S-M-001` at revision `R2` while QuickBooks/NetSuite still holds the single
-- string `N1S-M-001-R2`. That split was the right call — it is what makes
-- revising a part keep one identity with history, and what makes where-used work
-- across revisions — but it means PACE part numbers do not match the ERP
-- verbatim for those 14 parts today.
--
-- Without `externalId` the join rule has to be `concat(partNumber, '-', revision)`
-- on the ERP side, which encodes the split into every integration that ever
-- touches this data. `externalId` holds the original ERP string instead, so the
-- join is an equality on a column.
--
-- `sourcePartNumber` is retained through the importer's parse, so the value to
-- backfill into `externalId` for those 14 is already known and does not have to
-- be reconstructed.
--
-- Scope
-- ─────
--
--   * Nullable. A part that exists only in PACE has no ERP record and no
--     `externalId`, and that is the normal case during design.
--   * Unique per tenant, enforced by a partial index so the nulls do not
--     collide with each other. Two PACE parts pointing at one NetSuite item is
--     the failure mode this prevents — it makes a push ambiguous and a pull
--     destructive.
--   * Never set by the UI. Both PUT handlers validate against a Zod allowlist
--     — `UpdatePartSchema` and `UpdateBomSchema` — and `externalId` is on
--     neither, so an unknown key in a request body is dropped rather than
--     written. Adding it to either schema should be a deliberate decision with
--     a reason, not a convenience.
--
-- No new tables, so the RLS posture is unchanged — `parts` and `boms` are both
-- already locked down by migration 039, and adding a column does not alter that.
--
-- Verified before writing: `npm run probe:schema` reports no code/schema
-- mismatches across 40 live tables, and `grep -rn externalId src` returns
-- nothing, so no code reads or writes this column yet. Note what that does NOT
-- establish: the probe only reports columns the *code* references, so it says
-- nothing about whether `externalId` already exists in the database. `add
-- column if not exists` is what makes that question moot, which is the whole
-- point of the idempotency rule.
--
-- Idempotent and re-runnable, per docs/decisions/hand-applied-migrations.md.

-- ── parts ───────────────────────────────────────────────────────────────────

alter table parts
  add column if not exists "externalId" text;

comment on column parts."externalId" is
  'Identifier of this part in the ERP (NetSuite/QuickBooks). Null until linked. '
  'Written by importers and syncs only, never by the UI. For the 14 parts whose '
  'ERP number embeds the revision, this holds the original unsplit string.';

drop index if exists parts_tenant_external_id_key;
create unique index parts_tenant_external_id_key
  on parts ("tenantId", "externalId")
  where "externalId" is not null;

-- ── boms ────────────────────────────────────────────────────────────────────

alter table boms
  add column if not exists "externalId" text;

comment on column boms."externalId" is
  'Identifier of this BOM revision in the ERP. Null until linked. Written by '
  'importers and syncs only, never by the UI.';

drop index if exists boms_tenant_external_id_key;
create unique index boms_tenant_external_id_key
  on boms ("tenantId", "externalId")
  where "externalId" is not null;

-- ── Verify ──────────────────────────────────────────────────────────────────
--
-- Paste this after running the above. Expect two rows, both `text` and
-- nullable, and two unique partial indexes.
--
--   select table_name, column_name, data_type, is_nullable
--     from information_schema.columns
--    where column_name = 'externalId'
--      and table_name in ('parts', 'boms');
--
--   select indexname, indexdef
--     from pg_indexes
--    where indexname in ('parts_tenant_external_id_key', 'boms_tenant_external_id_key');
