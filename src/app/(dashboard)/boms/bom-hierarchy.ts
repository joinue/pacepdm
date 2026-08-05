import type { BOM } from "./types";

/**
 * Splitting the BOM list into what people actually go looking for.
 *
 * A flat list is fine while a tenant has a handful of BOMs. It stops being
 * fine the moment a real product is imported: the NANO-1000S build list
 * produces 26 BOMs of which one is a machine and the other 25 are its
 * commodity groups and sub-assemblies. Rendered flat they all look equally
 * important, and the thing you came for is one row in twenty-six.
 *
 * `usedIn` is derived server-side from `bom_items.linkedBomId`, so this
 * reflects the structure as it actually is rather than a flag someone has to
 * remember to set. A BOM created by hand and not yet used anywhere is
 * top-level, which is correct — it just has no parents yet.
 */

export interface BomGroups {
  /** Referenced by no other BOM: products, and anything not yet linked up. */
  topLevel: BOM[];
  /** Referenced by at least one other BOM, sorted by their parent's name. */
  subAssemblies: BOM[];
  /**
   * The subset of `topLevel` that looks like a link broken by a typo — the
   * server found a line referencing a near-miss of this BOM's name. Called
   * out separately because "top-level" and "orphaned by a typo" look
   * identical in the data but mean opposite things to the reader.
   */
  orphans: BOM[];
}

/** Alphabetical, case-insensitive, stable. */
function byName(a: BOM, b: BOM): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

export function groupBoms(boms: BOM[]): BomGroups {
  const topLevel: BOM[] = [];
  const subAssemblies: BOM[] = [];

  for (const bom of boms) {
    if ((bom.usedIn?.length ?? 0) > 0) subAssemblies.push(bom);
    else topLevel.push(bom);
  }

  // Grouping sub-assemblies under their parent's name keeps siblings
  // together, which is how someone scanning for "the electrical groups of
  // the 1000S" actually reads the list.
  subAssemblies.sort((a, b) => {
    const parent = (a.usedIn?.[0]?.name ?? "").localeCompare(b.usedIn?.[0]?.name ?? "", undefined, {
      sensitivity: "base",
    });
    return parent !== 0 ? parent : byName(a, b);
  });

  return {
    topLevel: topLevel.sort(byName),
    subAssemblies,
    orphans: topLevel.filter((b) => !!b.orphanHint),
  };
}
