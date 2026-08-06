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
its own cost as authoritative, and nothing should push it to NetSuite.

## Why there is no as-built / serial record here

PDM owns what the design **is** at each revision, and when that revision takes
effect. ERP owns what was actually **consumed** to build a specific unit.

NetSuite's work order records which components were issued against serial #47,
and that is the as-built record. Building a second one in PACE would be a worse
copy of it, fed by hand, that drifts from the real one.

Serial _effectivity_ stays here, because it is a property of the change: "this
revision applies from unit 100 onward" is a decision the ECO makes. What
actually shipped is a fact the work order records.

**The caveat worth knowing before relying on this:** it holds only if the
NetSuite work orders capture component genealogy, which needs serialized or
lot-tracked inventory on the _components_, not just on the finished machine. If
only the top-level unit is serialized, then "which bracket revision is in unit
47" is answerable from effectivity plus the ECO date rather than from a hard
record — the difference between naming the affected units and naming a date
range. That is normally acceptable for equipment. It is worth confirming with
whoever configures NetSuite, and it does not change anything in this repo.

## What this rules out

- **A part-number generator in PACE.** If one is ever added it is a placeholder
  scheme with an explicit reconciliation step, not an authority.
- **Pushing PACE cost to NetSuite.** In any direction, ever.
- **Matching parts across the two systems by part number** in any sync,
  importer, or report. Use `externalId`; if it is null, the part is not linked
  yet and that is the answer.
- **An as-built table.** If a warranty or recall question genuinely cannot be
  answered from NetSuite, reopen this decision rather than adding one quietly.

## Related

- [`bom-structure.md`](bom-structure.md) — structure derived, designation declared; `isEndItem` maps to NetSuite's _Available for Sale_
- [`hand-applied-migrations.md`](hand-applied-migrations.md) — why 051 was verified against the live database rather than assumed
- [`../plans/cad-erp-integration.md`](../plans/cad-erp-integration.md) — the remaining integration work this constrains
