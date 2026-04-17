import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";
import {
  computeBomRollup,
  BomCycleError,
  BomNotFoundError,
  type RollupBom,
} from "@/lib/bom-rollup";

/**
 * GET /api/boms/[bomId]/rollup
 *
 * Computes the cost/quantity rollup for a BOM, walking through any
 * sub-assemblies linked via `bom_items.linkedBomId`. Returns a flattened
 * tree of lines plus aggregate totals — the UI uses this to render the
 * "Rollup" panel on the BOM detail page.
 *
 * Strategy: fetch the root BOM, then iteratively pull every linked
 * sub-BOM until we've materialized the whole tree, then hand the
 * map to `computeBomRollup` which does the math. We do the BFS here
 * (not in the lib) because the lib is intentionally I/O-free.
 *
 * Cycles are caught defensively at compute time and surfaced as a 400
 * with the cycle path. Cycles are also rejected at insert time in the
 * BOM items POST/PUT route, so reaching this branch means somebody
 * snuck a row in directly or a race slipped through.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ bomId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { bomId } = await params;
    const db = getServiceClient();

    // Tenant ownership check on the root BOM. Sub-BOMs reached through
    // `linkedBomId` are filtered by tenantId at fetch time too — a
    // cross-tenant link should be impossible (the items POST refuses to
    // link a BOM that isn't in the same tenant), but defense in depth.
    const { data: rootBom } = await db
      .from("boms")
      .select("id, name, revision, tenantId")
      .eq("id", bomId)
      .eq("tenantId", tenantUser.tenantId)
      .single();

    if (!rootBom) {
      return NextResponse.json({ error: "BOM not found" }, { status: 404 });
    }

    // BFS over linkedBomId to materialize the whole tree. We cap depth
    // and total BOM count as a sanity guard against pathological inputs;
    // the cycle check is the primary defense, this just stops a runaway
    // even if both checks failed.
    const MAX_BOMS = 500;
    const bomsById = new Map<string, RollupBom>();
    const toFetch = new Set<string>([bomId]);
    let safety = 0;

    while (toFetch.size > 0) {
      if (++safety > MAX_BOMS) {
        return NextResponse.json(
          { error: "BOM tree exceeds maximum size (500 BOMs)" },
          { status: 400 }
        );
      }

      const ids = Array.from(toFetch);
      toFetch.clear();

      const [{ data: bomRows }, { data: itemRows }] = await Promise.all([
        db
          .from("boms")
          .select("id, name, revision")
          .eq("tenantId", tenantUser.tenantId)
          .in("id", ids),
        db
          .from("bom_items")
          .select("id, bomId, linkedBomId, itemNumber, partNumber, name, quantity, unit, unitCost")
          .in("bomId", ids)
          .order("sortOrder"),
      ]);

      const itemsByBom = new Map<string, RollupBom["items"]>();
      for (const item of itemRows || []) {
        const list = itemsByBom.get(item.bomId) || [];
        list.push({
          id: item.id,
          bomId: item.bomId,
          linkedBomId: item.linkedBomId,
          itemNumber: item.itemNumber || "",
          partNumber: item.partNumber,
          name: item.name || "",
          quantity: item.quantity ?? 0,
          unit: item.unit || "EA",
          unitCost: item.unitCost,
        });
        itemsByBom.set(item.bomId, list);
        // Queue sub-BOMs for the next BFS round, skipping ones we've
        // already loaded to avoid re-fetching across cycles
        if (item.linkedBomId && !bomsById.has(item.linkedBomId)) {
          toFetch.add(item.linkedBomId);
        }
      }

      for (const b of bomRows || []) {
        bomsById.set(b.id, {
          id: b.id,
          name: b.name,
          revision: b.revision,
          items: itemsByBom.get(b.id) || [],
        });
      }
    }

    try {
      const result = computeBomRollup(bomId, bomsById);
      return NextResponse.json({
        bomId,
        bomName: rootBom.name,
        bomRevision: rootBom.revision,
        ...result,
      });
    } catch (err) {
      if (err instanceof BomCycleError) {
        return NextResponse.json(
          { error: err.message, cyclePath: err.cyclePath },
          { status: 400 }
        );
      }
      if (err instanceof BomNotFoundError) {
        return NextResponse.json({ error: err.message }, { status: 404 });
      }
      throw err;
    }
  } catch (err) {
    console.error("Failed to compute BOM rollup:", err);
    const message = err instanceof Error ? err.message : "Failed to compute BOM rollup";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
