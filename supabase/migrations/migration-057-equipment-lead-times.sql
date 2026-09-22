-- PACE PDM Migration 057: equipment lead times
--
-- Sales asked engineering for a lead time per machine and got a spreadsheet
-- (PACE_Equipment_Lead_Time_Tracker_V1.xlsx). This is that sheet as a table,
-- with the two columns that rot in a shared file — "Updated date" and "Who
-- updated this" — stamped by the app instead of typed, and every previous
-- value kept.
--
-- ── What is stored ──────────────────────────────────────────────────────
--
-- One row per model. `typicalLeadTime` is the baseline the sheet set at four
-- weeks; `currentLeadTime` is what sales quotes today. Both are free text
-- holding one of the buckets the sheet's dropdown offered ("In Stock",
-- "6-8 weeks", "Confirm", …) — the list lives in src/lib/lead-times.ts, and
-- is not a CHECK constraint because the list is a sales convention that will
-- change, and a refused write here would surface as a 500 with no useful
-- message.
--
-- `equipment_lead_time_changes` is the history: one row per change, with what
-- it was and what it became. A spreadsheet overwrites; "what did we tell them
-- in July" is the question this table answers.
--
-- ── Not linked to parts, deliberately ───────────────────────────────────
--
-- These models exist as end items in `parts` eventually, but the lead-time
-- page must work before the part library is complete, which is the whole
-- reason sales asked for a spreadsheet. `partId` is nullable and unused for
-- now; linking is a later step, and nothing here depends on it.
--
-- ── RLS ─────────────────────────────────────────────────────────────────
--
-- Deny-all, like every other table reached only through server code with the
-- service role (docs/decisions/rls-new-tables.md). Add both tables to
-- scripts/probe-rls.mjs.
--
-- ── Seed ────────────────────────────────────────────────────────────────
--
-- The 33 models from the sheet, for every existing tenant, with the sheet's
-- four-week baseline as `typicalLeadTime` and no current value — a blank
-- current lead time reads as "nobody has said yet" in the app, which is the
-- truth on day one. Guarded by NOT EXISTS on (tenantId, model), so pasting
-- this twice is a no-op and a model someone has already edited is untouched.
--
-- ── Permission ──────────────────────────────────────────────────────────
--
-- `leadtime.edit` is new (src/lib/permissions.ts). DEFAULT_ROLES only runs
-- at tenant creation, so existing roles are backfilled below: any role that
-- can already state engineering facts (file.edit or eco.edit) gets it.
-- Viewer does not, which is what sales holds — they read the page.
--
-- Idempotent throughout. Not verified against the live database.

-- ── 1. The tables ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "equipment_lead_times" (
  "id" text PRIMARY KEY,
  "tenantId" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "model" text NOT NULL,
  "description" text,
  "typicalLeadTime" text,
  "currentLeadTime" text,
  "notes" text,
  "partId" text REFERENCES "parts"("id") ON DELETE SET NULL,
  "updatedById" text REFERENCES "tenant_users"("id") ON DELETE SET NULL,
  "updatedAt" timestamptz,
  "createdById" text REFERENCES "tenant_users"("id") ON DELETE SET NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "deletedAt" timestamptz
);

-- One row per model per tenant. Case-insensitive, because "Pico-200" and
-- "PICO-200" are the same machine to everyone who reads this page.
CREATE UNIQUE INDEX IF NOT EXISTS "equipment_lead_times_tenant_model_unique"
  ON "equipment_lead_times" ("tenantId", lower("model"))
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "equipment_lead_times_tenant_idx"
  ON "equipment_lead_times" ("tenantId", "model");

CREATE TABLE IF NOT EXISTS "equipment_lead_time_changes" (
  "id" text PRIMARY KEY,
  "tenantId" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "leadTimeId" text NOT NULL REFERENCES "equipment_lead_times"("id") ON DELETE CASCADE,
  "fromLeadTime" text,
  "toLeadTime" text,
  "note" text,
  "changedById" text REFERENCES "tenant_users"("id") ON DELETE SET NULL,
  "changedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "equipment_lead_time_changes_row_idx"
  ON "equipment_lead_time_changes" ("leadTimeId", "changedAt" DESC);

-- ── 2. RLS: deny-all, server-only ───────────────────────────────────────

ALTER TABLE "equipment_lead_times"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "equipment_lead_time_changes" ENABLE ROW LEVEL SECURITY;

-- ── 3. Seed the models from the sheet ───────────────────────────────────

INSERT INTO "equipment_lead_times" ("id", "tenantId", "model", "description", "typicalLeadTime", "createdAt")
SELECT gen_random_uuid()::text, t."id", v.model, v.description, '4 weeks', now()
FROM "tenants" t
CROSS JOIN (VALUES
  ('MEGA-M250S',  'Manual Abrasive Cutter - 10"'),
  ('MEGA-T250S',  'Manual Abrasive Cutter - 10"'),
  ('MEGA-T300S',  'Manual Abrasive Cutter - 12"'),
  ('MEGA-T350S',  'Manual Abrasive Cutter - 14"'),
  ('MEGA-T400S',  'Manual Abrasive Cutter - 16"'),
  ('MEGA-T300A',  'Automated Abrasive Cutter - 12"'),
  ('MEGA-T350A',  'Automated Abrasive Cutter - 14"'),
  ('MEGA-T400A',  'Automated Abrasive Cutter - 16"'),
  ('PICO-155P',   'Low-to-Medium Speed Precision Saw'),
  ('PICO-155S',   'Digital Low-to-Medium Speed Precision Saw'),
  ('PICO-200',    'Manual Medium-Speed Precision Saw'),
  ('PICO-200S',   'Manual Medium-Speed Precision Saw'),
  ('PICO-200A',   'Automatic Medium-Speed Precision Saw'),
  ('TP-7100S',    'Automated Pneumatic Press'),
  ('TP-7500S',    'Automated Hydraulic Press'),
  ('TP-TANK',     'Recirculating Cooling Tank'),
  ('TeraVAC',     'Vacuum Mounting System'),
  ('TeraVAC Pro', 'Vacuum Mounting System'),
  ('TeraCOMP',    'Pressure Mounting System'),
  ('TeraUV',      'UV Mounting Curing System'),
  ('PENTA-5000A', 'Hand Grinder'),
  ('PENTA-7500S', 'Belt Grinder'),
  ('NANO-1000S',  'Wheel Polisher'),
  ('NANO-1200S',  'Wheel Polisher'),
  ('NANO-2000S',  'Wheel Polisher'),
  ('FEMTO-1100S', 'Polishing Head'),
  ('FEMTO-1500S', 'Polishing Head'),
  ('FEMTO-2200S', 'Polishing Head'),
  ('FEMTO-2500S', 'Polishing Head'),
  ('ATTO-1000S',  'Controlled Removal Polisher'),
  ('GIGA-S',      'Vibratory Polisher'),
  ('ZETA-2000S',  'Automated Abrasive Dispenser'),
  ('RC-1000A',    'Recirculating Filter System')
) AS v(model, description)
WHERE NOT EXISTS (
  SELECT 1 FROM "equipment_lead_times" e
   WHERE e."tenantId" = t."id"
     AND lower(e."model") = lower(v.model)
);

-- ── 4. Backfill the new permission ──────────────────────────────────────

UPDATE "roles"
   SET "permissions" = "permissions" || '["leadtime.edit"]'::jsonb,
       "updatedAt" = now()
 WHERE NOT ("permissions" @> '["leadtime.edit"]'::jsonb)
   AND NOT ("permissions" @> '["*"]'::jsonb)
   AND ("permissions" @> '["file.edit"]'::jsonb OR "permissions" @> '["eco.edit"]'::jsonb);

-- ── Verification ────────────────────────────────────────────────────────
--
--   -- 33 models per tenant, none with a current lead time yet:
--   select "tenantId", count(*), count("currentLeadTime")
--     from "equipment_lead_times" where "deletedAt" is null group by 1;
--
--   -- who can now edit them:
--   select name, permissions @> '["leadtime.edit"]'::jsonb as can_edit from roles order by 1;
--
--   -- both tables refuse anon reads (or run: npm run probe:rls):
--   select relname, relrowsecurity from pg_class
--    where relname in ('equipment_lead_times', 'equipment_lead_time_changes');
