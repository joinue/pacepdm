# SolidWorks and NetSuite integration — decisions to make before loading real data

**Started:** 2026-08-04 · **Last updated:** 2026-08-05 · **Status:** in progress — importer built, item master next

<!-- plan-metrics
bom-import-route: 1
erp-external-id: 1-->

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

**1. No external identifier.** Any sync would key on `partNumber` string
matching, which breaks the first time someone edits a part number — and is
already broken by the revision split, before anyone has edited anything.
Migration 051 adds `externalId` to `parts` and `boms`; **it is written but not
applied**, and `bom_items` deliberately does not get one (a line is identified
by its parent BOM plus its `partId`, not independently). → gated below.

**~~2. BOM lines can be free text.~~ Closed 2026-08-06.**
`DRAFT → IN_REVIEW` on `PUT /api/boms/[bomId]` now refuses while any line has
neither a `partId` nor a `linkedBomId`, naming the first five offenders so the
error is actionable.

Three things worth knowing before changing it:

- **The rule is "resolves to a part _or_ to a BOM".** A sub-assembly line
  legitimately has no `partId` — it carries `linkedBomId`. Requiring `partId`
  outright would make every nested assembly unreleasable, which is most of the
  imported set.
- **Only the forward transition is gated.** IN_REVIEW → DRAFT and
  APPROVED → DRAFT stay open, or a BOM that acquired a bad line could never be
  sent back to the one place it can be fixed.
- **The columns stay.** Free text while drafting is the useful part; the gate
  is on leaving DRAFT, not on typing.

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

**3. `parts.unitCost` and `parts.currency` duplicate NetSuite costing.**
**Settled 2026-08-06: NetSuite owns cost; the PACE field is an engineering
estimate and is kept**, because the BOM rollup needs a number before the item
master lands and an all-zero rollup cannot sanity-check an imported structure.
Nothing in PACE may ever present its cost as authoritative or push it to
NetSuite — see [`../decisions/erp-ownership.md`](../decisions/erp-ownership.md).
**Still to do: relabel the field in the UI**, which today says "Unit Cost ($)"
with no qualifier.

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

### ~~1. Pick one part numbering scheme, authoritative in one place~~ Settled 2026-08-06

**NetSuite owns part numbers and cost.** The earlier recommendation here was a
split — PACE issuing numbers for engineered parts — and it was rejected: two
minting authorities need a rule about which applies, and that rule gets applied
wrongly the first time somebody designs a part that turns out to be purchasable.

Recorded in [`../decisions/erp-ownership.md`](../decisions/erp-ownership.md),
along with the revision-split consequence and why the join is `externalId`.

**One workflow question this leaves open**, which is not blocking and is not a
schema problem: a newly designed part has no number until NetSuite issues one.
Either the engineer waits, or PACE holds a placeholder reconciled later. Answer
it when parts start being created in anger.

`splitRevision` in [`bom-import.ts`](../../src/lib/bom-import.ts) is strict
about the shape (`-R` followed by digits, at the end). `PS-24V-LRS75-24` and
`POW-E-STOP-1CR` correctly do not match. The residual risk is a part that
genuinely ends in `-R<n>` without meaning a revision; `sourcePartNumber` is
retained through the parse so such a case stays traceable.

### ~~2. Add `externalId` to `parts` and `boms`~~ Written 2026-08-06 — apply it

[`migration-051-erp-external-id.sql`](../../supabase/migrations/migration-051-erp-external-id.sql).
Nullable `text` on both tables, unique per tenant via a partial index so the
nulls do not collide.

**Not yet applied.** Migrations here are hand-pasted into the Supabase SQL
editor, so this is written and reviewed but not live until someone runs it. The
migration ends with a verify block to paste afterwards. Until it is applied,
treat this item as open —
[`../decisions/hand-applied-migrations.md`](../decisions/hand-applied-migrations.md)
is explicit that the files are not a ledger.

Nothing writes the column yet, and no route accepts it: both PUT handlers
validate against a Zod allowlist (`UpdatePartSchema`, `UpdateBomSchema`) and
`externalId` is on neither, so it can only ever be set by an importer or a sync.

The value to backfill for the 14 revision-suffixed parts is already known —
`sourcePartNumber` is retained through the importer's parse, so it does not have
to be reconstructed from `concat(partNumber, '-', revision)`.

---

## Sequencing

1. ~~**The two decisions above.**~~ Revision handling settled (split).
   `externalId` migration written (051) — **paste it into the Supabase SQL
   editor**; it is not live until you do. Part number authority between PACE
   and NetSuite is the one still genuinely open, and it is a policy call rather
   than code.
2. ~~**BOM CSV import.**~~ Built — see above.
3. **Import the item master.** Now the top item: the build list gave structure
   but no cost, description, material or vendor, so every BOM currently rolls
   up to zero. Export items from QuickBooks/NetSuite and run
   `POST /api/parts/import`, which already upserts by part number. Watch the
   revision split — ERP part numbers will carry the `-R<n>` the PACE ones no
   longer have.
4. **Add `externalId`** (item 2 under decisions above). More urgent after the
   revision split, since part numbers no longer match the ERP verbatim.
5. ~~**Require `partId` on every line before `DRAFT → IN_REVIEW`.**~~ Done
   2026-08-06 — see [NetSuite side](#netsuite-side) item 2.
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
