import type { BOM } from "./types";

/**
 * Turning the BOM list into the tree it actually is.
 *
 * A flat list misrepresents an imported product: the NANO-1000S build list
 * produces 26 BOMs of which one is a machine and 25 are its groups and
 * sub-assemblies. Splitting them into "products" and "sub-assemblies" was
 * better than nothing, but the sub-assembly section is the part that grows —
 * a second machine makes it 50 rows, a fifth makes it well over 100, and none
 * of them say what they belong to except by a line of small print.
 *
 * So: products at the top, their children nested underneath, collapsed until
 * asked for. The tree is derived from `usedIn`, which the list endpoint
 * computes from `bom_items.linkedBomId` — structure as it actually is, not a
 * field anyone maintains.
 */

export interface BomTreeNode {
  bom: BOM;
  children: BomTreeNode[];
  /** Nesting level from the root, 0 for a product. Drives indentation. */
  depth: number;
  /** Every BOM at or below this node, counted once each. */
  descendantCount: number;
}

export interface BomTree {
  /**
   * Declared end items — someone marked the part as sold or shipped on its
   * own. Shown at the top regardless of structure, so a sub-assembly you
   * also sell appears here AND nested under every machine that uses it.
   * Both statements are true.
   */
  products: BomTreeNode[];
  /**
   * Unreferenced BOMs nobody has designated: new drafts, work in progress,
   * and anything not yet linked into a parent. Deliberately not called
   * "products" — being unused is not the same as being sellable, and the
   * old label claimed the second from the first.
   */
  topLevel: BomTreeNode[];
  /** `products` followed by `topLevel` — what the page actually renders. */
  roots: BomTreeNode[];
  /**
   * Roots that look like a link broken by a typo rather than a real product
   * — the server found a line referencing a near-miss of the name.
   */
  orphans: BOM[];
  /** Total BOMs below a root, so the header can say what is hidden. */
  subAssemblyCount: number;
}

/** Alphabetical, case-insensitive, stable. */
function byName(a: BomTreeNode, b: BomTreeNode): number {
  return a.bom.name.localeCompare(b.bom.name, undefined, { sensitivity: "base" });
}

export function buildBomTree(boms: BOM[]): BomTree {
  const byId = new Map(boms.map((b) => [b.id, b]));

  // `usedIn` points child → parents. Invert it once so the walk below is a
  // lookup rather than a scan per node.
  const childrenOf = new Map<string, BOM[]>();
  const roots: BOM[] = [];
  for (const bom of boms) {
    const parents = bom.usedIn ?? [];
    if (parents.length === 0) {
      roots.push(bom);
      continue;
    }
    for (const parent of parents) {
      // A parent outside this list (deleted, or beyond the 500 the endpoint
      // returns) would strand the child. Treat it as a root so it stays
      // reachable rather than vanishing from the page.
      if (!byId.has(parent.id)) {
        if (!roots.includes(bom)) roots.push(bom);
        continue;
      }
      const siblings = childrenOf.get(parent.id) ?? [];
      siblings.push(bom);
      childrenOf.set(parent.id, siblings);
    }
  }

  const subAssemblies = new Set<string>();

  /**
   * `path` guards against a cycle in the data. `wouldCreateCycle` stops the
   * API creating one, but a row written before that guard existed — or by
   * hand in SQL — must not hang the page.
   */
  const build = (bom: BOM, depth: number, path: Set<string>): BomTreeNode => {
    if (path.has(bom.id)) {
      return { bom, children: [], depth, descendantCount: 0 };
    }
    const nextPath = new Set(path).add(bom.id);
    const children = (childrenOf.get(bom.id) ?? [])
      .map((child) => {
        subAssemblies.add(child.id);
        return build(child, depth + 1, nextPath);
      })
      .sort(byName);

    return {
      bom,
      children,
      depth,
      descendantCount: children.reduce((n, c) => n + 1 + c.descendantCount, 0),
    };
  };

  // A declared end item is shown at the top even when it is also somebody's
  // child. That is the whole point of keeping designation separate from
  // structure: a spare you sell is both.
  const endItems = boms.filter((b) => b.isEndItem);
  const structuralRoots = roots.filter((b) => !b.isEndItem);

  const products = endItems.map((b) => build(b, 0, new Set())).sort(byName);
  const topLevel = structuralRoots.map((b) => build(b, 0, new Set())).sort(byName);

  return {
    products,
    topLevel,
    roots: [...products, ...topLevel],
    orphans: structuralRoots.filter((b) => !!b.orphanHint),
    subAssemblyCount: subAssemblies.size,
  };
}

/**
 * Flatten a node into the rows to render, given which nodes are expanded.
 *
 * Rendering is a flat list rather than nested markup so every row is a
 * sibling in the DOM: nesting buttons inside buttons is invalid, and the
 * indentation is a visual concern that `depth` already carries.
 */
export function visibleRows(nodes: BomTreeNode[], expanded: Set<string>): BomTreeNode[] {
  const out: BomTreeNode[] = [];
  const walk = (list: BomTreeNode[]) => {
    for (const node of list) {
      out.push(node);
      if (node.children.length > 0 && expanded.has(node.bom.id)) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}
