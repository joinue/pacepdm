-- PACE PDM Migration 053: use-up effectivity
--
-- Adds 'USE_UP' to the `ecos.effectivityType` check constraint.
--
-- Why
-- ───
--
-- The enum offered IMMEDIATE, DATE and SERIAL, and the most common case in
-- equipment manufacture is none of them. A change usually takes effect **when
-- existing stock of the old design is used up** — production keeps building
-- the old one until the shelf is empty, then switches. It is not a date, and
-- it is not a serial.
--
-- Without a value for it, anyone recording a real change either invents a date
-- that reality will not honour, or leaves the field blank. Both are worse than
-- an option that says what is actually true.
--
-- What this does NOT enable
-- ─────────────────────────
--
-- Nothing computable. `USE_UP` is a **declaration of intent**, and deliberately
-- so: the trigger is inventory level, which lives in the ERP and always will.
-- No query here can answer "has the old stock run out". Neither can SERIAL —
-- that needs the unit's serial, also in the ERP.
--
-- So the app answers "is this in effect?" for IMMEDIATE and DATE, and for the
-- other two displays the recorded intent and says where the answer lives. A
-- query that looks right and is wrong in practice is worse than no query. See
-- docs/decisions/erp-ownership.md.
--
-- DATE and SERIAL stay
-- ────────────────────
--
-- PACE will mostly use IMMEDIATE (safety changes) and USE_UP (everything else).
-- That is one tenant's pattern, not the product's: serial effectivity is
-- standard in aerospace and medical devices, and date cutoffs are normal
-- wherever a regulation or a supplier contract sets one. Removing an option
-- because one tenant does not use it is not a multi-tenant decision.
--
-- No column is added and no data is migrated — existing rows keep whatever they
-- have, and every one of them is still valid under the widened constraint.
--
-- Verified before writing: `ecos_effectivityType_check` exists with exactly the
-- three original values, added by migration 046.
--
-- Idempotent and re-runnable, per docs/decisions/hand-applied-migrations.md.

alter table "ecos" drop constraint if exists "ecos_effectivityType_check";

alter table "ecos" add constraint "ecos_effectivityType_check"
  check (
    "effectivityType" is null
    or "effectivityType" in ('IMMEDIATE', 'DATE', 'SERIAL', 'USE_UP')
  );

comment on column "ecos"."effectivityType" is
  'When the change takes effect. IMMEDIATE and DATE are computable here; '
  'SERIAL and USE_UP are declarations whose trigger lives in the ERP — the '
  'app displays them and defers rather than calculating. See '
  'docs/decisions/erp-ownership.md.';

-- ── Verify ──────────────────────────────────────────────────────────────────
--
-- Paste after running. Expect the four values, and no existing row rejected.
--
--   select pg_get_constraintdef(oid)
--     from pg_constraint
--    where conname = 'ecos_effectivityType_check';
--
--   select "effectivityType", count(*)
--     from "ecos" group by 1 order by 1;
