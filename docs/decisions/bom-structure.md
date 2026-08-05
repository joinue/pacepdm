# BOM structure is derived; product designation is declared

**Status:** active
**Applies to:** `boms`, `bom_items`, `parts`, and anything that renders a BOM hierarchy

## The rule

Two facts about a BOM look similar and are not:

| Fact                                | How we answer it                                        |
| ----------------------------------- | ------------------------------------------------------- |
| Where does this sit in the product? | **Derived** from `bom_items.linkedBomId`. Never stored. |
| Is this something we sell?          | **Declared** on `parts.isEndItem`. Never inferred.      |

Never add a column that stores the first, and never compute the second.

## Why structure is derived

A BOM's position is a relationship, not a property. The same BOM can be a
child of one machine, a child of three others, and a thing in its own right,
all at once — `NANO-S Standard-Components` belongs to every machine in the S
family. No field on the BOM row can express that; a `parentBomId` would be
wrong the moment a second machine used it, and an `isSubAssembly` boolean
would need maintaining by hand and would drift the first time someone forgot.

So `buildBomTree` in [`src/app/(dashboard)/boms/bom-hierarchy.ts`](../../src/app/%28dashboard%29/boms/bom-hierarchy.ts)
reads `usedIn` — which `GET /api/boms` computes from `bom_items.linkedBomId`
— and nests accordingly. Structure in the UI cannot disagree with structure
in the data, because there is only one copy of it.

This matches how the established systems work. In Windchill and Teamcenter a
part is a part; its place in any structure comes from the structure, and
where-used answers containment. SolidWorks PDM has no notion of "this file is
a sub-assembly" either — only of what references what.

## Why designation is declared

"Is this a product" cannot be computed from structure, and the attempt is
where this went wrong before. The BOM list originally labelled every
unreferenced BOM a **Product**, which broke in both directions:

- a draft BOM nobody had linked yet appeared as a product;
- a sub-assembly also sold as a spare was buried inside its parent and
  appeared as a product nowhere.

Both are ordinary situations for a manufacturer, and the second is a whole
revenue line for most equipment businesses.

The established systems keep these apart too, and put the designation on the
item: Windchill has an **End Item** designation on a part that says nothing
about its position in any structure, and NetSuite has assembly items with
bills of materials and **Available for Sale** as an entirely independent
field.

## Why `isEndItem` lives on `parts`, not on `boms`

Because a sellable item need not have a bill of materials at all. `PW-1000A`
and `PW-800A` are the polishing wheels sold separately with the NANO-1000S:
real products, no assembly, no BOM. A flag on `boms` could not represent
them; a flag on the item can, and it maps directly onto the ERP field it will
eventually sync to.

This is also why migration 044 added **`boms.partId`**. For a designation on
the part to reach the BOM list, a BOM has to know which item it describes.
Before that column, the only link was the importer's convention that a BOM's
name equals its part's number — invisible to the schema and one rename from
breaking. `partId` is nullable, so a hand-made BOM with no part still works;
it simply cannot be designated until it has one.

Going further would mean making `partId` required, which is closer to
Windchill and Teamcenter, where a bill of materials is not a free-standing
object but the structure _of_ an item. That is a reasonable future direction
and deliberately not today's change.

## What this looks like in the UI

`/boms` renders two root sections:

- **Products** — parts marked as end items, shown at the top **regardless of
  structure**. A sub-assembly you also sell appears here _and_ nested under
  every machine that uses it. Two true statements, not a duplicate.
- **Top level** — unreferenced BOMs nobody has designated. Drafts, work in
  progress, things not yet linked to a parent.

Everything else is nested under its parents, collapsed by default.

## Consequences to keep in mind

- **Nothing is an end item until a person says so.** Migration 044
  deliberately backfills no designations. After importing, every BOM lands
  under "Top level" until someone marks the machines — which is the honest
  state, not a bug.
- **A BOM with no `partId` cannot be designated.** It has no item to carry
  the flag. The importer sets `partId`; `POST /api/boms` does not, so
  hand-made BOMs need a part linked before they can be products.
- **Do not read `usedIn.length === 0` as "product".** That was the original
  mistake. It means "nothing references this", which is a different and much
  weaker claim.

## Related

- [`tenant-isolation.md`](tenant-isolation.md) — `bom_items` has no `tenantId` and is reached through its parent BOM
- [`../plans/cad-erp-integration.md`](../plans/cad-erp-integration.md) — `isEndItem` maps to NetSuite's _Available for Sale_ when the ERP push is built
