import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";

/**
 * GET /api/ecos/[ecoId]/bom-impact
 *
 * Returns every BOM that contains parts affected by this ECO, along with
 * the specific line items that will see a revision bump on implementation.
 * Designed for the ECO review flow: an approver opens the ECO and sees
 * the downstream BOM impact without leaving the page.
 *
 * The query walks: eco_items (partId) → bom_items (partId) → boms,
 * then enriches each hit with the ECO item's fromRevision/toRevision so
 * the UI can show "PN-100: A → B" per line.
 */

interface AffectedBomItem {
  itemNumber: string;
  partNumber: string;
  partName: string;
  currentRevision: string;
  toRevision: string;
  quantity: number;
  unitCost: number | null;
}

interface AffectedBom {
  bomId: string;
  bomName: string;
  bomRevision: string | null;
  bomStatus: string;
  affectedItems: AffectedBomItem[];
  totalItems: number;
}

interface BomImpactResponse {
  affectedBoms: AffectedBom[];
  summary: {
    totalBoms: number;
    totalItemsAffected: number;
  };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ ecoId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { ecoId } = await params;
    const db = getServiceClient();

    // Verify ECO exists and belongs to tenant.
    const { data: eco } = await db
      .from("ecos")
      .select("id")
      .eq("id", ecoId)
      .eq("tenantId", tenantUser.tenantId)
      .single();
    if (!eco) {
      return NextResponse.json({ error: "ECO not found" }, { status: 404 });
    }

    // Step 1: collect every part this ECO affects along with the
    // planned revision transition.
    const { data: ecoItems } = await db
      .from("eco_items")
      .select("partId, fromRevision, toRevision")
      .eq("ecoId", ecoId)
      .not("partId", "is", null);

    if (!ecoItems || ecoItems.length === 0) {
      const empty: BomImpactResponse = {
        affectedBoms: [],
        summary: { totalBoms: 0, totalItemsAffected: 0 },
      };
      return NextResponse.json(empty);
    }

    const partRevMap = new Map<string, { from: string | null; to: string | null }>();
    for (const item of ecoItems) {
      partRevMap.set(item.partId as string, {
        from: (item.fromRevision as string | null) ?? null,
        to: (item.toRevision as string | null) ?? null,
      });
    }
    const affectedPartIds = Array.from(partRevMap.keys());

    // Step 2: find every BOM item that references one of these parts.
    // Join through to the BOM header and the part row for display fields.
    const { data: bomItemRows, error: biErr } = await db
      .from("bom_items")
      .select(`
        itemNumber, quantity, unitCost,
        part:parts!bom_items_partId_fkey(id, partNumber, name, revision),
        bom:boms!bom_items_bomId_fkey(id, name, revision, status, tenantId)
      `)
      .in("partId", affectedPartIds);
    if (biErr) throw biErr;

    // Step 3: group by BOM, filtering to this tenant and enriching with
    // the ECO's planned revision transition.
    const bomMap = new Map<string, AffectedBom>();
    const bomTotalItems = new Map<string, number>();

    for (const row of bomItemRows ?? []) {
      const bom = (Array.isArray(row.bom) ? row.bom[0] : row.bom) as {
        id: string; name: string; revision: string | null; status: string; tenantId: string;
      } | null;
      const part = (Array.isArray(row.part) ? row.part[0] : row.part) as {
        id: string; partNumber: string; name: string; revision: string;
      } | null;
      if (!bom || !part || bom.tenantId !== tenantUser.tenantId) continue;

      const revInfo = partRevMap.get(part.id);
      if (!revInfo) continue;

      let entry = bomMap.get(bom.id);
      if (!entry) {
        entry = {
          bomId: bom.id,
          bomName: bom.name,
          bomRevision: bom.revision,
          bomStatus: bom.status,
          affectedItems: [],
          totalItems: 0,
        };
        bomMap.set(bom.id, entry);
      }

      entry.affectedItems.push({
        itemNumber: (row.itemNumber as string) ?? "",
        partNumber: part.partNumber,
        partName: part.name,
        currentRevision: revInfo.from ?? part.revision,
        toRevision: revInfo.to ?? part.revision,
        quantity: (row.quantity as number) ?? 0,
        unitCost: (row.unitCost as number | null) ?? null,
      });
    }

    // Step 4: get total item counts per BOM so the UI can show
    // "3 of 15 items affected." Done in one query for all affected BOMs.
    if (bomMap.size > 0) {
      const bomIds = Array.from(bomMap.keys());
      const { data: countRows } = await db
        .from("bom_items")
        .select("bomId")
        .in("bomId", bomIds);
      for (const r of countRows ?? []) {
        bomTotalItems.set(
          r.bomId as string,
          (bomTotalItems.get(r.bomId as string) ?? 0) + 1
        );
      }
      for (const [bomId, entry] of bomMap) {
        entry.totalItems = bomTotalItems.get(bomId) ?? 0;
      }
    }

    const affectedBoms = Array.from(bomMap.values());
    let totalItemsAffected = 0;
    for (const b of affectedBoms) totalItemsAffected += b.affectedItems.length;

    const response: BomImpactResponse = {
      affectedBoms,
      summary: {
        totalBoms: affectedBoms.length,
        totalItemsAffected,
      },
    };
    return NextResponse.json(response);
  } catch (err) {
    console.error("GET /api/ecos/[ecoId]/bom-impact failed:", err);
    const message = err instanceof Error ? err.message : "Failed to compute BOM impact";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
