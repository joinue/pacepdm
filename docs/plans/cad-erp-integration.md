# SolidWorks and NetSuite integration — decisions to make before loading real data

**Started:** 2026-08-04 · **Last updated:** 2026-08-04 · **Status:** not started, decisions pending

<!-- plan-metrics
bom-import-route: 0
erp-external-id: 0
-->

PACE Technologies is deploying this internally as the BOM of record and the
change-control system for our equipment line. SolidWorks is upstream, NetSuite
is downstream. This plan captures where the seams are, what is cheap to do now
and expensive later, and what should deliberately stay manual.

Nothing here is started. The two items under [Decide before loading real
data](#decide-before-loading-real-data) are the only ones that get materially
harder with every part we enter, so they gate the rest.

---

## Who owns what

The one framing that prevents most integration pain:

| System         | Owns                                                                  |
| -------------- | --------------------------------------------------------------------- |
| **SolidWorks** | Geometry and assembly structure — the engineering truth               |
| **PACE**       | Revision, change approval, released state, the engineering BOM (eBOM) |
| **NetSuite**   | Items, purchasing, inventory, work orders, actual cost (mBOM)         |

Almost every failure mode in a CAD → PDM → ERP chain is two systems both
believing they own part numbers, or both believing they own cost. The schema
today quietly sets us up for both collisions; see [NetSuite side](#netsuite-side).

---

## SolidWorks side

There is no add-in and no CAD reference parsing, and there is no plan to build
either — that is what SolidWorks PDM Standard is for, and it is a different
product in a different discipline. The workflow here is export-driven:

1. Engineer exports the assembly BOM table from SolidWorks.
2. Imports it into PACE, where it becomes the eBOM under revision control.
3. Drawings are published to PDF and attached to the part or file.

### What already fits

`bom_items` holds `partNumber`, `name`, `description`, `quantity`, `unit`,
`material`, `vendor`, `unitCost`, plus `level` and `parentItemId` — so it can
represent an indented multi-level BOM, which is exactly the shape SolidWorks
exports. If we standardise the SolidWorks custom properties (part number,
description, revision, material), the export maps close to 1:1.

Thumbnails already work for `.sldprt` / `.sldasm` / `.slddrw` (the embedded
preview bitmap) and for PDF. Real 3D rendering of native SolidWorks files is
not possible — occt-import-js reads neutral formats only. If 3D preview
matters, uploads need an accompanying STEP export. Noted in
[`codebase-hardening.md`](codebase-hardening.md#product-gaps-found-along-the-way).

### The gap: there is no BOM import

`/api/parts/import` takes a CSV of parts. `/api/boms/[bomId]/export` gets a BOM
out. **Nothing gets BOM lines in** — today that means hand entry, which is a
non-starter for onboarding the existing equipment line.

This is the highest-leverage piece of work in this plan. Build
`POST /api/boms/[bomId]/import` as a mirror of the parts importer:

- Same per-row result shape. The parts importer deliberately does not run in a
  transaction — 497 good rows land and 3 bad ones are reported — and that is
  the right behaviour here too. See the rationale comment at the top of
  [`parts/import/route.ts`](../../src/app/api/parts/import/route.ts).
- Header aliases keyed to whatever our SolidWorks BOM template actually emits.
  Capture a real export first and map against it rather than guessing.
- Indent level → `level` / `parentItemId`. This is the part the parts importer
  has no equivalent for and where the bugs will be.
- Resolve `partNumber` to a `parts` row and set `partId` where it matches;
  report unmatched rows rather than silently creating free-text lines (see the
  free-text problem below).

### What we will not get

Without a CAD add-in: no knowledge that an assembly needs its N child files,
no lock on a part someone has open in SolidWorks, no automatic follow on a
rename. Check-out here is a database flag, not a file lock on disk. Accept
this, or run SolidWorks PDM Standard alongside for the vault and use PACE for
BOM/ECO only.

---

## NetSuite side

The natural handoff is **ECO implement**. When an ECO flips to `IMPLEMENTED`,
the released BOM is what ERP should receive as an Assembly Item plus BOM
Revision. [`ecos/[ecoId]/implement`](../../src/app/api/ecos/[ecoId]/implement/route.ts)
runs inside a Postgres function so the whole transition commits or rolls back —
that makes it a reliable trigger to hang a sync off later.

Four things block automating it today.

**1. No external identifier.** `parts`, `boms`, and `bom_items` have no
`externalId` / `erpId` column. Any sync would key on `partNumber` string
matching, which breaks the first time someone edits a part number. → gated
below.

**2. BOM lines can be free text.** `bom_items.partId` is nullable and sits
beside plain `partNumber` / `name` / `vendor` columns. A line with no `partId`
cannot map to a NetSuite item. The flexibility is genuinely useful while
drafting, so the fix is not to drop the columns — it is to require every line
to be resolved to a part before the BOM can leave `DRAFT`. Enforce it in the
`DRAFT → IN_REVIEW` transition, not at sync time, so the error surfaces to the
person who can fix it.

**3. `parts.unitCost` and `parts.currency` duplicate NetSuite costing.** Two
costing systems drift, and the ERP one is the one Finance believes. Either
relabel the PACE field explicitly as an engineering estimate in the UI, or
drop it. Decide before anyone starts populating it.

**4. No machine-to-machine auth.** Every route resolves a browser session via
`getApiTenantUser`. The only exception is the shared `CRON_SECRET` bearer check
on the cron endpoint. NetSuite — or a middleware layer like Celigo or Boomi —
cannot authenticate against this API at all. Automating the push needs a
service-account variant of `withTenant` that accepts an API key and resolves to
a synthetic tenant user with a narrow permission set.

---

## Decide before loading real data

These two get harder with every part entered. Everything else in this plan can
wait.

### 1. Pick one part numbering scheme, authoritative in one place

Policy, not code, and the decision everything else depends on.

Recommendation: **PACE issues numbers for engineered parts and NetSuite mirrors
them; NetSuite owns purchased-item numbers.** Write the outcome into
[`../decisions/`](../decisions/) once agreed — it is a standing decision, not a
plan item.

### 2. Add `externalId` to `parts` and `boms`

One migration now, versus a reconciliation project once there are several
hundred parts with no stable link to their NetSuite records. Nullable, unique
per tenant, never set by the UI:

```sql
alter table parts add column if not exists "externalId" text;
create unique index if not exists parts_tenant_external_id_key
  on parts ("tenantId", "externalId") where "externalId" is not null;
```

Same for `boms`. Idempotent and re-runnable, per
[`../decisions/hand-applied-migrations.md`](../decisions/hand-applied-migrations.md),
and RLS stays as-is since no new table is created.

---

## Sequencing

1. **The two decisions above.** Blocking; everything else assumes them.
2. **BOM CSV import** shaped to our real SolidWorks export.
3. **Require `partId` on every line before `DRAFT → IN_REVIEW`.** Cheap, and it
   is what makes an eventual ERP push possible at all.
4. **Resolve the `unitCost` ownership question** — relabel or remove.
5. **Stop here and stay manual.** PACE BOM export → NetSuite CSV import
   assistant is a legitimate steady state for an equipment line releasing a
   handful of BOM revisions a month. This is not a stopgap to apologise for.
6. **Only when the manual handoff actually hurts:** service-account auth, then
   a push-on-ECO-implement job keyed on `externalId`.

Do not start 6 early. It is the item most likely to be built, then not trusted,
then bypassed with a spreadsheet.

---

## Related

- Internal single-tenant deployment changes the priority order of
  [`codebase-hardening.md`](codebase-hardening.md) — read the note at its top.
- Trash/undelete is a prerequisite for trusting this as the BOM of record, and
  is tracked there rather than here.
- No serial number or as-built tracking exists; ECOs have a free-text
  `effectivity` field and nothing else. If we ever need "which BOM revision
  shipped on unit #47", that is a schema addition. Worth deciding while the
  data model is still small.
