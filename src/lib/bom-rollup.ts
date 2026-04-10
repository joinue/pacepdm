// BOM rollup: walk a BOM tree (including sub-assemblies linked via
// `linkedBomId`) and compute totals — total cost, total weight, line count,
// max depth. Pure function on top of pre-fetched data, so it's trivially
// testable and the API route stays a thin wrapper around two SELECTs and
// one call into here.
//
// Why a separate lib instead of inlining in the route: BOM math is the
// thing most likely to grow new requirements (different cost methods,
// scrap factors, currency conversion, parent-quantity multiplication
// rules), and tests for that math should not have to spin up Supabase.

export interface RollupBomItem {
  id: string;
  bomId: string;
  /** When set, this line is a sub-assembly that points at another BOM. */
  linkedBomId: string | null;
  itemNumber: string;
  partNumber: string | null;
  name: string;
  quantity: number;
  unit: string;
  unitCost: number | null;
}

export interface RollupBom {
  id: string;
  name: string;
  revision: string;
  items: RollupBomItem[];
}

export interface RollupLine {
  /** "1" or "1.2.3" — dot-joined item-number path from the root BOM down. */
  path: string;
  bomId: string;
  bomName: string;
  itemId: string;
  itemNumber: string;
  partNumber: string | null;
  name: string;
  /** Cumulative quantity from the root: parent qty × this qty × … */
  effectiveQuantity: number;
  unit: string;
  unitCost: number | null;
  /** unitCost × effectiveQuantity, or null if no cost on this line. */
  extendedCost: number | null;
  /** Tree depth — root items are 0, sub-items are 1, etc. */
  depth: number;
  /** True for items that link to another BOM (a sub-assembly node). */
  isSubAssembly: boolean;
}

export interface RollupResult {
  /** Sum of `extendedCost` across every leaf line. Null cost lines contribute 0. */
  totalCost: number;
  /** Number of leaf items (sub-assembly nodes themselves are not counted). */
  leafItemCount: number;
  /** Number of distinct lines in the flattened tree (incl. sub-assembly headers). */
  totalLineCount: number;
  /** Deepest nesting level reached (0 for a flat BOM). */
  maxDepth: number;
  /** Flattened DFS walk of the tree, parents before children. */
  lines: RollupLine[];
  /** Number of items where unitCost was null — surfaced so the UI can warn. */
  itemsMissingCost: number;
}

export class BomCycleError extends Error {
  constructor(public readonly cyclePath: string[]) {
    super(`BOM cycle detected: ${cyclePath.join(" → ")}`);
    this.name = "BomCycleError";
  }
}

export class BomNotFoundError extends Error {
  constructor(public readonly missingBomId: string) {
    super(`Linked BOM not found: ${missingBomId}`);
    this.name = "BomNotFoundError";
  }
}

/**
 * Compute a rollup for `rootBomId` against a pre-fetched map of BOMs.
 *
 * The route handler is responsible for fetching every BOM the tree might
 * touch (typically: the root, plus everything reachable through
 * `linkedBomId`). This function does no I/O — it just walks.
 *
 * Cycle detection is via a per-walk visited set: if we re-enter a BOM
 * that's already on the current path, we throw `BomCycleError`. This
 * is a defensive layer; cycles should also be rejected at insert time
 * (see boms/[bomId]/items POST), but rollup must not loop forever even
 * if a cycle slipped through.
 */
export function computeBomRollup(
  rootBomId: string,
  bomsById: Map<string, RollupBom>
): RollupResult {
  const root = bomsById.get(rootBomId);
  if (!root) {
    throw new BomNotFoundError(rootBomId);
  }

  const lines: RollupLine[] = [];
  let totalCost = 0;
  let leafItemCount = 0;
  let maxDepth = 0;
  let itemsMissingCost = 0;

  const walk = (
    bom: RollupBom,
    parentQty: number,
    depth: number,
    pathSegments: string[],
    visiting: Set<string>
  ): void => {
    if (visiting.has(bom.id)) {
      // Cycle: emit a readable path "Frame → Wheel → Frame"
      const names: string[] = [];
      for (const visitedId of visiting) {
        const visited = bomsById.get(visitedId);
        names.push(visited?.name ?? visitedId);
      }
      names.push(bom.name);
      throw new BomCycleError(names);
    }

    if (depth > maxDepth) maxDepth = depth;

    visiting.add(bom.id);

    for (const item of bom.items) {
      const effectiveQty = parentQty * (item.quantity || 0);
      const path = [...pathSegments, item.itemNumber || "?"].join(".");
      const isSub = item.linkedBomId !== null;

      // Sub-assembly header line — represents the link, not a costable
      // leaf. Its own cost is null (the children carry the cost).
      if (isSub) {
        const child = bomsById.get(item.linkedBomId!);
        if (!child) {
          // Missing child BOM — emit a row so the UI can show the gap,
          // but don't crash the rollup. Treat it as a leaf with no cost.
          lines.push({
            path,
            bomId: bom.id,
            bomName: bom.name,
            itemId: item.id,
            itemNumber: item.itemNumber,
            partNumber: item.partNumber,
            name: `${item.name} (missing sub-BOM)`,
            effectiveQuantity: effectiveQty,
            unit: item.unit,
            unitCost: null,
            extendedCost: null,
            depth,
            isSubAssembly: true,
          });
          continue;
        }

        lines.push({
          path,
          bomId: bom.id,
          bomName: bom.name,
          itemId: item.id,
          itemNumber: item.itemNumber,
          partNumber: item.partNumber,
          name: item.name,
          effectiveQuantity: effectiveQty,
          unit: item.unit,
          unitCost: null,
          extendedCost: null,
          depth,
          isSubAssembly: true,
        });

        // Recurse into the sub-BOM. Quantity multiplies through:
        // 1 frame × 4 wheels = 4 wheels at the leaf level.
        walk(child, effectiveQty, depth + 1, [...pathSegments, item.itemNumber || "?"], visiting);
        continue;
      }

      // Leaf line — actually contributes to cost
      const ext = item.unitCost !== null ? item.unitCost * effectiveQty : null;
      if (ext !== null) totalCost += ext;
      if (item.unitCost === null) itemsMissingCost++;
      leafItemCount++;

      lines.push({
        path,
        bomId: bom.id,
        bomName: bom.name,
        itemId: item.id,
        itemNumber: item.itemNumber,
        partNumber: item.partNumber,
        name: item.name,
        effectiveQuantity: effectiveQty,
        unit: item.unit,
        unitCost: item.unitCost,
        extendedCost: ext,
        depth,
        isSubAssembly: false,
      });
    }

    visiting.delete(bom.id);
  };

  walk(root, 1, 0, [], new Set());

  return {
    totalCost,
    leafItemCount,
    totalLineCount: lines.length,
    maxDepth,
    lines,
    itemsMissingCost,
  };
}

/**
 * Check whether linking `targetBomId` as a sub-assembly inside `parentBomId`
 * would create a cycle. Used by the BOM items POST/PUT route to refuse the
 * write up front instead of letting the bad row land and surfacing later
 * during rollup.
 *
 * Returns the cycle path (as bom names or ids) if a cycle would form,
 * or null if the link is safe.
 */
export function wouldCreateCycle(
  parentBomId: string,
  targetBomId: string,
  bomsById: Map<string, RollupBom>
): string[] | null {
  // Self-link is always a cycle
  if (parentBomId === targetBomId) {
    const parent = bomsById.get(parentBomId);
    return [parent?.name ?? parentBomId, parent?.name ?? parentBomId];
  }

  // DFS from the target — if we reach the parent, the link would close a loop.
  const visited = new Set<string>();
  const stack: { bomId: string; path: string[] }[] = [
    { bomId: targetBomId, path: [bomsById.get(targetBomId)?.name ?? targetBomId] },
  ];

  while (stack.length > 0) {
    const { bomId, path } = stack.pop()!;
    if (bomId === parentBomId) {
      const parentName = bomsById.get(parentBomId)?.name ?? parentBomId;
      return [parentName, ...path, parentName];
    }
    if (visited.has(bomId)) continue;
    visited.add(bomId);

    const bom = bomsById.get(bomId);
    if (!bom) continue;

    for (const item of bom.items) {
      if (item.linkedBomId) {
        stack.push({
          bomId: item.linkedBomId,
          path: [...path, bomsById.get(item.linkedBomId)?.name ?? item.linkedBomId],
        });
      }
    }
  }

  return null;
}
