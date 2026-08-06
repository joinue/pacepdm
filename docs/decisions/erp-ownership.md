# ERP ownership: one owner per fact, chosen per tenant

**Status:** active
**Decided:** 2026-08-06
**Applies to:** `parts`, `boms`, `bom_items`, `/api/parts/import`, `/api/boms/import`, any future ERP sync

> **Two things live in this file and they are not the same.** The **product
> rules** below are invariants — true for every tenant, and code depends on
> them. **PACE's configuration** is one customer's answer to the questions
> those rules leave open, recorded here because the repo has no other place
> for it.
>
> This app is multi-tenant. A tenant with no ERP at all is a supported and
> ordinary case. **Do not read PACE's answers as the product's assumptions** —
> the first thing a second customer's setup does is contradict several of them.

## The product rules

1. **Every fact has exactly one owner.** Part numbers have one; cost has one.
   Which system that is varies by tenant; that there is only one does not.
2. **Systems join on `externalId`, never on part number.** In any sync,
   importer or report. A null `externalId` means the record is not linked yet,
   and that is the answer.
3. **PACE always owns the engineering record** — revision, change approval,
   released state, effectivity, the engineering BOM. That is the product.
4. **PACE cost never flows outward.** Whatever a tenant's cost owner is, an
   engineer's figure typed here must not be able to overwrite it.

Almost every failure in a CAD → PDM → ERP chain is two systems both believing
they own part numbers, or both believing they own cost. Rule 1 is the whole
decision; the rest follow from it.

### What the product leaves to the tenant

| Question                | Knob             | Values                                                  |
| ----------------------- | ---------------- | ------------------------------------------------------- |
| Who issues part numbers | `partNumberMode` | `AUTO` (PACE mints) / `MANUAL` (entered from elsewhere) |
| Who owns cost           | `costSource`     | `OPEN` (PACE) / `LOCKED` (an external system)           |

A tenant with no ERP runs `AUTO` and `OPEN` and never thinks about any of this.
Both fields already exist and are per-tenant; nothing below changes that.

## PACE Technologies' configuration

**NetSuite owns part numbers and cost.** SolidWorks is upstream for geometry;
NetSuite is downstream for items, purchasing, inventory, work orders and sales.

The earlier recommendation was a split — PACE issuing numbers for engineered
parts, NetSuite for purchased ones. Rejected: a split means two minting
authorities and a rule about which applies, and that rule gets applied wrongly
the first time somebody designs a part that turns out to be purchasable. One
authority, and it is the system that already has to know about every item in
order to buy, stock, cost and sell it.

**The consequence to design around:** a newly designed part has no number until
NetSuite issues one. Either the engineer waits, or PACE holds a placeholder that
is reconciled later. Not settled, and it does not need to be until parts are
being created in anger — a workflow question rather than a schema one.
`externalId` makes the reconciliation mechanical whichever way it goes.

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

## Cost: two fields, because relabelling one serves only tenants with an ERP

**Product rule.** A part carries **`estimatedCost`** and **`unitCost`**, and the
difference is authority rather than precision.

| Field           | Who writes it                          | When cost is locked |
| --------------- | -------------------------------------- | ------------------- |
| `estimatedCost` | any engineer                           | still editable      |
| `unitCost`      | an engineer, or an ERP sync once built | read-only           |

The tenant setting `costSource` decides: `OPEN` (default) or `LOCKED`.

The earlier plan was to relabel `unitCost` as an estimate and stop. **That is
the mistake this file exists to prevent**: it reads as a product decision and is
actually one tenant's configuration. A team with no ERP has no other place to
record what a part costs, so calling their only cost field an estimate makes it
useless to them.

Two fields serve both. PACE locks `unitCost` and defers to NetSuite. A tenant
without an ERP leaves it `OPEN`, and `unitCost` is simply their cost — real,
authoritative, and edited here. Neither is the "correct" setup.

`estimatedCost` stays writable in both modes on purpose. Locking it too would
leave an engineer with nowhere to put a working figure, which is the same
failure as the relabel.

`bom_items.unitCost` is deliberately **not** split. A line-level override is a
judgement about one use of a part rather than about the part, so it is an
estimate by nature. Splitting it too would produce four numbers per line and no
way to reason about which the rollup used.

Added by [`migration-052`](../../supabase/migrations/migration-052-estimated-cost.sql).

### What the rollup does with all this

Each line's cost resolves in descending order of authority: the override typed
on the BOM line, then the part's `unitCost`, then the part's `estimatedCost`.
Before this the rollup read the line override **and nothing else**, so a part
priced perfectly well in the parts library contributed zero to every total it
appeared in — understating silently, which is the worst way for a cost to be
wrong.

The basis travels with the number, and the rollup reports
`itemsUsingEstimate` beside the existing `itemsMissingCost`. **A total that
mixes real cost with guesses has to say so.** A missing cost visibly
understates; an estimate blends in — $48,000 with $8,000 of guesswork looks
exactly like $48,000 of real cost, and that is the number somebody quotes.
Individual lines are marked `est.` so the warning is actionable rather than
merely alarming.

Option lines are excluded from the count: only one member of a group ever
ships, so their basis says nothing about the base configuration's total.

Resolution happens in the rollup route, not in `bom-rollup.ts` — the engine is
pure and is handed items, and the route is the only place that knows where a
figure came from.

Two costing systems drift, and where a tenant has an ERP, the ERP one is the one
Finance believes. The mitigation is labelling, not arithmetic — a locked tenant's
PACE cost must never present itself as authoritative.

### Sync direction, when it is built

**Inward is the goal. Outward must never carry cost.** Product rule 4, and the
one thing about cost that does not vary by tenant.

Pulling real cost down from an ERP is the point of the eventual integration: it
is what turns a BOM rollup from an estimate into a number worth quoting. That
direction is wanted.

The reverse is not, and the asymmetry is the whole reason cost has a single
owner. A PACE `estimatedCost` is an engineer's figure typed into a form. If it
could reach the ERP it could overwrite what Finance believes, and nobody would
see it happen — the two look identical on the wire. The estimate is a local
convenience that gets _replaced_ by the real figure, never one that competes
with it.

## Which machine went to which customer: two different questions

These sound like one question and are not, and confusing them is how a PDM ends
up rebuilding half an ERP.

| Question                                          | Answered by                                | Owned by     |
| ------------------------------------------------- | ------------------------------------------ | ------------ |
| "What **type** of machine did this customer get?" | The BOM revision in effect when it shipped | **PACE**     |
| "Which **physical parts** went into unit #47?"    | The work order that issued them            | **NetSuite** |

### PACE owns the machine version. It does not always know when it took effect.

A machine has versions — NANO-1000S revision B, then C — and PACE owns that
outright: the revision lineage (`previousRevisionId` / `supersededById`) is the
record of what the design was at each step, and the released structure is
immutable.

**When a version took effect is a different matter, and PACE can only sometimes
answer it.** The ECO records the intent in `effectivityType` / `effectiveFrom` /
`effectiveSerial`, but whether that intent is _computable_ depends on the type:

| Effectivity   | Can PACE answer "is it in effect?"                    |
| ------------- | ----------------------------------------------------- |
| Immediate     | **Yes** — from the implementation date                |
| From a date   | **Yes**                                               |
| From a serial | **No** — needs the unit's serial, which is in the ERP |
| On use-up     | **No** — needs inventory levels, which are in the ERP |

The last two are not gaps to be closed. The determining input lives in the ERP
and always will, so a query here would produce a confident answer that is wrong
in practice. The honest output is _"from serial N1S-0470 — check the unit in
your ERP"_, and an app that computes something instead is worse than one that
says that.

**This matters more than it looks for how a change actually rolls out.** The
common case in equipment manufacture is use-up: the new design is released, and
production keeps building the old one until existing stock is consumed. So
`RELEASED` and `in effect` are routinely different states, separated by an
inventory fact PACE cannot see. Anything that treats a released revision as
automatically the one being built is wrong for that tenant.

`implement_eco` does not read effectivity at all today — implementing an ECO
releases the carried revision immediately regardless of what the ECO says.
That is defensible (releasing the design is not the same as switching
production) but it is undocumented and worth stating.

> Tracked as item 3 in
> [`../plans/change-control.md`](../plans/change-control.md), now scoped to what
> is actually answerable rather than to a general "what is in effect" query.

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

- **A part-number generator acting as an authority where the tenant has named
  another owner.** `partNumberMode: AUTO` is exactly such a generator and is
  correct for a tenant with no ERP — what is ruled out is minting numbers
  alongside a system that also mints them. For PACE that means any generator is
  a placeholder scheme with an explicit reconciliation step.
- **Any sync that carries PACE cost outward.** The other direction is the goal;
  this one never happens, for any tenant.
- **Matching parts across the two systems by part number** in any sync,
  importer, or report. Use `externalId`; if it is null, the part is not linked
  yet and that is the answer.
- **An as-built table**, recording which physical components went into a serial.
  That is the work order's job.
- **Computing "is this in effect?" for serial or use-up effectivity.** The
  determining input is in the ERP. Display the intent and defer; do not
  calculate. Ruled out because the tempting fix — a query that looks right and
  is wrong in practice — is worse than the absence.

## Related

- [`bom-structure.md`](bom-structure.md) — structure derived, designation declared; `isEndItem` maps to NetSuite's _Available for Sale_
- [`hand-applied-migrations.md`](hand-applied-migrations.md) — why 051 was verified against the live database rather than assumed
- [`../plans/cad-erp-integration.md`](../plans/cad-erp-integration.md) — the remaining integration work this constrains
