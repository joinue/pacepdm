# ERP ownership: NetSuite owns identity and cost, PACE owns the engineering record

**Status:** active
**Decided:** 2026-08-06
**Applies to:** `parts`, `boms`, `bom_items`, `/api/parts/import`, `/api/boms/import`, any future NetSuite sync

## The rule

| System         | Is authoritative for                                                         |
| -------------- | ---------------------------------------------------------------------------- |
| **SolidWorks** | Geometry and assembly structure — the engineering truth                      |
| **NetSuite**   | **Part numbers**, **cost**, items, purchasing, inventory, work orders, sales |
| **PACE**       | Revision, change approval, released state, effectivity, the engineering BOM  |

The two systems join on `parts.externalId` / `boms.externalId`, not on part
number string matching.

Almost every failure in a CAD → PDM → ERP chain is two systems both believing
they own part numbers, or both believing they own cost. This decision picks one
owner for each, and it is not PACE.

## Why NetSuite owns part numbers

The earlier recommendation in the integration plan was a split — PACE issues
numbers for engineered parts, NetSuite for purchased ones. That was rejected.
A split means two minting authorities and a rule about which applies, and the
rule gets applied wrongly the first time someone designs a part that turns out
to be purchasable.

One authority, and it is the system that already has to know about every item
in order to buy, stock, cost and sell it.

**The consequence to design around:** a newly designed part has no number until
NetSuite issues one. Either the engineer waits, or PACE holds a placeholder that
is reconciled later. This is not settled and does not need to be until parts are
being created in anger — but it is the question to answer, and it is a workflow
question rather than a schema one. `externalId` already makes the reconciliation
mechanical whichever way it goes.

## Why the join is `externalId` and not `partNumber`

The usual argument is that string matching breaks the first time somebody
corrects a part number. Here it is already broken, before anyone has edited
anything.

The archive bakes the revision into the number — `N1S-M-001-R2`, `N1S-SA-A-R4`,
14 of them. The BOM importer splits those, so PACE holds part `N1S-M-001` at
revision `R2` while QuickBooks/NetSuite holds the single string `N1S-M-001-R2`.

That split was the right call: it is what makes revising a part keep one
identity with its history, and what makes where-used work across revisions —
the main thing a PDM buys over a spreadsheet. But it means PACE part numbers do
not match the ERP verbatim for those parts.

Without `externalId` the join rule is `concat(partNumber, '-', revision)` on the
ERP side, which encodes that split into every integration that ever touches this
data. `externalId` holds the original ERP string instead, so the join is an
equality on a column.

Added by [`migration-051`](../../supabase/migrations/migration-051-erp-external-id.sql),
applied 2026-08-06 and verified live on both tables. The value to backfill for
the 14 affected parts is already known — `sourcePartNumber` is retained through
the importer's parse.

`bom_items` deliberately has no `externalId`: a line is identified by its parent
BOM plus its `partId`, not independently.

## Why `parts.unitCost` still exists

NetSuite owns cost, so the PACE field is an **engineering estimate**. It is not
dropped, for one reason: the BOM rollup needs a number before the item master
import lands, and a rollup that is structurally correct and entirely zero is not
useful for sanity-checking an imported structure.

> **Not yet reflected in the UI.** The field is still labelled "Unit Cost ($)"
> with no qualifier, which is exactly the ambiguity this decision exists to
> remove. Tracked in
> [`../plans/cad-erp-integration.md`](../plans/cad-erp-integration.md).

Two costing systems drift, and the ERP one is the one Finance believes. The
mitigation is labelling, not arithmetic — nothing in PACE should ever present
its own cost as authoritative.

### Sync direction, when it is built

**NetSuite → PACE is the goal. PACE → NetSuite must never carry cost.**

Pulling real cost down from NetSuite is the point of the eventual integration:
it is what turns the BOM rollup from an estimate into a number worth quoting.
That direction is wanted.

The reverse is not, and the asymmetry is the whole reason cost has a single
owner. A PACE `unitCost` is an engineer's estimate typed into a form. If it can
reach NetSuite it can overwrite what Finance believes, and nobody would see it
happen — the field looks identical on both sides. So the estimate is a local
convenience that gets _replaced_ by the real figure, never one that competes
with it.

## Which machine went to which customer: two different questions

These sound like one question and are not, and confusing them is how a PDM ends
up rebuilding half an ERP.

| Question                                          | Answered by                                | Owned by     |
| ------------------------------------------------- | ------------------------------------------ | ------------ |
| "What **type** of machine did this customer get?" | The BOM revision in effect when it shipped | **PACE**     |
| "Which **physical parts** went into unit #47?"    | The work order that issued them            | **NetSuite** |

### PACE owns the machine version and the timeline

This is a first-class job here, not a gap. A machine has versions — NANO-1000S
revision B, then C — and a timeline saying when each took effect. Together they
answer what configuration a customer received, which is what you need for
service documentation, for a spares list, and for scoping who is affected by a
change.

The data for it already exists and is typed: BOM revision lineage
(`previousRevisionId` / `supersededById`), and `effectivityType` /
`effectiveFrom` / `effectiveSerial` on the ECO.

> **The data is stored and nothing reads it.** There is no query today that
> answers "what was in effect on 1 March" or "which revision covers unit 47".
> Both are straightforward now that the columns are typed, and both were
> impossible before. Tracked as item 3 in
> [`../plans/change-control.md`](../plans/change-control.md), and it is the
> open item that delivers the capability described in this section.

### NetSuite owns what was physically consumed

The work order records which components were issued to build a specific serial.
Building a second copy of that here would be fed by hand and would drift from
the real one, so there is no as-built table in PACE and there should not be.

**The limit worth knowing before relying on it:** NetSuite answers this at
component level only if serialised or lot-tracked inventory is enabled on the
_components_, not just on the finished machine. If only the top-level unit is
serialised, then "which bracket is in unit 47" resolves through PACE's
effectivity instead — which gives you the revision that _should_ be in it, and a
date range rather than a definitive per-unit list. For equipment that is usually
enough; for a recall it is the difference between naming units and naming a
window. Worth confirming with whoever configures NetSuite. It changes nothing in
this repo either way.

## What this rules out

- **A part-number generator in PACE.** If one is ever added it is a placeholder
  scheme with an explicit reconciliation step, not an authority.
- **Any sync that carries PACE `unitCost` to NetSuite.** The other direction is
  the goal; this one never happens.
- **Matching parts across the two systems by part number** in any sync,
  importer, or report. Use `externalId`; if it is null, the part is not linked
  yet and that is the answer.
- **An as-built table**, recording which physical components went into a serial.
  That is the work order's job. It does **not** rule out answering "which
  version of the machine did this customer get" — that is PACE's job and is
  still to be built, above.

## Related

- [`bom-structure.md`](bom-structure.md) — structure derived, designation declared; `isEndItem` maps to NetSuite's _Available for Sale_
- [`hand-applied-migrations.md`](hand-applied-migrations.md) — why 051 was verified against the live database rather than assumed
- [`../plans/cad-erp-integration.md`](../plans/cad-erp-integration.md) — the remaining integration work this constrains
