# SolidWorks and NetSuite integration — decisions to make before loading real data

**Started:** 2026-08-04 · **Last updated:** 2026-08-05 · **Status:** in progress — importer built, item master next

<!-- plan-metrics
bom-import-route: 1
erp-external-id: 0
-->

PACE Technologies is deploying this internally as the BOM of record and the
change-control system for our equipment line. SolidWorks is upstream, NetSuite
is downstream. This plan captures where the seams are, what is cheap to do now
and expensive later, and what should deliberately stay manual.

The BOM importer is built (2026-08-05) and the revision-handling decision is
settled. What remains that gets materially harder with every part entered:
`externalId`, and part-number authority between PACE and NetSuite. See
[Sequencing](#sequencing).

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

### ~~The gap: there is no BOM import~~ Built 2026-08-05

`POST /api/boms/import` ([route](../../src/app/api/boms/import/route.ts),
parser in [`src/lib/bom-import.ts`](../../src/lib/bom-import.ts)).

**The spec that was here was wrong, and the correction matters.** It assumed an
indented SolidWorks export with one BOM per file, so it called for
`POST /api/boms/[bomId]/import` mapping indent level onto `level` /
`parentItemId`. The real archive format — `NANO-1000S Build (BOM) List.csv`,
now a test fixture at
[`src/lib/__fixtures__/`](../../src/lib/__fixtures__/nano-1000s-build-list.csv) —
is nothing like that:

- It comes from **QuickBooks**, not SolidWorks.
- It holds **26 BOMs in one file**, and the hierarchy is by **name reference**,
  not indentation: `NANO-1000S` lists `NANO-1000S Casting-Components` as a
  line, and that appears later as its own `BOM` block. That maps onto
  `bom_items.linkedBomId`, which already existed. `level`/`parentItemId` are
  not involved.
- So the route is whole-file. Splitting it per-BOM would make `linkedBomId`
  unresolvable until the last upload landed.

Three format traps, recorded because none are guessable from the header:

1. **`BOM` rows do not follow the header.** The header describes `Item` rows
   only. On a `BOM` row, column 1 is the part number and column 2 the
   description.
2. **The first `Item` of each BOM is `Create <X>` / `Finished Good`** — the
   BOM's own output, not a component. Import it and every BOM contains itself.
3. **`Description` on an item row is an action label** (`Add N1S-002`), not a
   description. Discarded.

Behaviour worth knowing before re-running it:

- **Not transactional**, matching the parts importer — bad rows are reported,
  good rows land. Ordering carries the invariant instead: every BOM row is
  written before any item row, so link resolution never depends on how far the
  run got.
- **Re-running is safe.** A BOM whose name already exists is skipped and
  reported, never duplicated or merged.
- **Every line gets a real `partId`.** Parts are upserted by part number first,
  so the importer cannot create the free-text lines the ERP section warns about.
- **Categories are not guessed.** A part heading its own BOM becomes
  `SUB_ASSEMBLY`; everything else takes the `MANUFACTURED` default. The source
  distinguishes only "Finished Good" from "Raw Good", which says nothing about
  whether a leaf is machined or bought. Fix in bulk later via
  `POST /api/parts/import`.

### What the build list does not carry

Structure, not part data. The 108 leaf parts arrive with **no description, no
cost, no material, no vendor** — those columns do not exist in the file. An
item-master export from QuickBooks or NetSuite is needed to fill them, and
`/api/parts/import` already takes that shape. Until then `unitCost` is null
across the board and rollup totals are structurally correct but zero.

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
person who can fix it. _Partly closed: `POST /api/boms/import` always resolves
`partId`, so imported BOMs are already clean. Hand-entered ones are not._

**2a. End items are already modelled, and map straight across.** Migration
044 added `parts.isEndItem` — declared, never inferred — which is the same
concept as NetSuite's _Available for Sale_ and Windchill's _End Item_. When
the push is built, that field decides what NetSuite should see as a sellable
item, independently of where the part sits in any BOM. See
[`../decisions/bom-structure.md`](../decisions/bom-structure.md).

**2b. Configure-to-order options do not exist in NetSuite's eyes either.**
Migration 043 added `bom_items.optionGroup` so the NANO-1000S can carry its
110V and 220V parts without the rollup charging for both. An ERP push has to
decide what an option line means to NetSuite — most likely: push the base
configuration only, and let order entry add the selected variant. Worth
settling with whoever owns the NetSuite side before the push is built.

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

**Half-settled on 2026-08-05.** The archive bakes the revision into the part
number — `N1S-M-001-R2`, `N1S-SA-A-R4`, 14 of them. Decision taken: the
importer **splits** them, so `N1S-M-001-R2` becomes part `N1S-M-001` at
revision `R2`. Revising a part now stays one part with history, and where-used
works across revisions — which is the main thing a PDM buys over a
spreadsheet.

The consequence to carry into the NetSuite mapping: **PACE part numbers no
longer match QuickBooks/NetSuite verbatim** for those 14 parts. The join rule
is `concat(partNumber, '-', revision)` on the ERP side, or an `externalId`
holding the original string — which is the argument for doing item 2 sooner
rather than later.

`splitRevision` in [`bom-import.ts`](../../src/lib/bom-import.ts) is strict
about the shape (`-R` followed by digits, at the end). `PS-24V-LRS75-24` and
`POW-E-STOP-1CR` correctly do not match. The residual risk is a part that
genuinely ends in `-R<n>` without meaning a revision; `sourcePartNumber` is
retained through the parse so such a case stays traceable.

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

1. ~~**The two decisions above.**~~ Revision handling settled (split). Part
   number authority between PACE and NetSuite still open, and `externalId` is
   still not added.
2. ~~**BOM CSV import.**~~ Built — see above.
3. **Import the item master.** Now the top item: the build list gave structure
   but no cost, description, material or vendor, so every BOM currently rolls
   up to zero. Export items from QuickBooks/NetSuite and run
   `POST /api/parts/import`, which already upserts by part number. Watch the
   revision split — ERP part numbers will carry the `-R<n>` the PACE ones no
   longer have.
4. **Add `externalId`** (item 2 under decisions above). More urgent after the
   revision split, since part numbers no longer match the ERP verbatim.
5. **Require `partId` on every line before `DRAFT → IN_REVIEW`.** Cheap, and it
   is what makes an eventual ERP push possible at all. The importer already
   guarantees it for imported BOMs; this closes hand-entered ones.
6. **Resolve the `unitCost` ownership question** — relabel or remove.
7. **Stop here and stay manual.** PACE BOM export → NetSuite CSV import
   assistant is a legitimate steady state for an equipment line releasing a
   handful of BOM revisions a month. This is not a stopgap to apologise for.
8. **Only when the manual handoff actually hurts:** service-account auth, then
   a push-on-ECO-implement job keyed on `externalId`.

Do not start 8 early. It is the item most likely to be built, then not trusted,
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
