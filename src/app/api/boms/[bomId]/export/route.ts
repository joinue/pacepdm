import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";
import { toCsv } from "@/lib/csv";

/**
 * GET /api/boms/[bomId]/export
 *
 * Flattens a BOM (including linked sub-assemblies, up to MAX_DEPTH levels)
 * into a single CSV.
 *
 * Every query in here is tenant-scoped, including the recursive descent:
 * `linkedBomId` is a plain FK with no tenant constraint of its own, so a
 * row pointing at another tenant's BOM would otherwise pull that BOM's
 * contents into this export. Each level re-checks tenancy rather than
 * trusting the parent's link.
 */

// Sub-assembly recursion cap. Deep enough for real product structures,
// shallow enough that a cyclic linkedBomId can't run away — and `seen`
// below stops a cycle outright.
const MAX_DEPTH = 5;

interface BomItemRow {
  itemNumber: string;
  partNumber: string | null;
  name: string;
  description: string | null;
  quantity: number;
  unit: string;
  level: number;
  material: string | null;
  vendor: string | null;
  unitCost: number | null;
  file: unknown;
  part: unknown;
  linkedBomId: string | null;
}

interface FileInfo {
  name: string;
  partNumber: string | null;
  revision: string;
  lifecycleState: string;
}
interface PartInfo {
  partNumber: string;
  name: string;
  category: string;
}

type Db = ReturnType<typeof getServiceClient>;

/**
 * Fetch a BOM's items, but only if the BOM itself belongs to `tenantId`.
 * Returns null when the BOM is missing, soft-deleted, or owned by another
 * tenant — the caller can't distinguish those, which is intentional.
 */
async function getItemsForBom(
  db: Db,
  tenantId: string,
  bomId: string
): Promise<BomItemRow[] | null> {
  const { data: bom } = await db
    .from("boms")
    .select("id")
    .eq("id", bomId)
    .eq("tenantId", tenantId)
    .is("deletedAt", null)
    .maybeSingle();
  if (!bom) return null;

  const { data } = await db
    .from("bom_items")
    .select(
      "itemNumber, partNumber, name, description, quantity, unit, level, material, vendor, unitCost, linkedBomId, file:files!bom_items_fileId_fkey(name, partNumber, revision, lifecycleState), part:parts!bom_items_partId_fkey(partNumber, name, category)"
    )
    .eq("bomId", bomId)
    .order("sortOrder");
  return (data || []) as BomItemRow[];
}

const HEADERS = [
  "Item #",
  "Part Number",
  "Name",
  "Description",
  "Qty",
  "Unit",
  "Level",
  "Material",
  "Vendor",
  "Unit Cost",
  "Part Category",
  "File",
  "File Rev",
  "File State",
];

/**
 * Reduce a BOM name to something safe to interpolate into a
 * Content-Disposition header. Without this a name containing a quote or
 * CRLF injects arbitrary response headers. Mirrors safeZipFilename in
 * lib/vault-zip.ts.
 */
function safeCsvFilename(base: string): string {
  const safe = base.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_");
  return `${safe || "bom"}.csv`;
}

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
    const tenantId = tenantUser.tenantId as string;

    const { data: bom } = await db
      .from("boms")
      .select("name")
      .eq("id", bomId)
      .eq("tenantId", tenantId)
      .is("deletedAt", null)
      .maybeSingle();
    if (!bom) {
      return NextResponse.json({ error: "BOM not found" }, { status: 404 });
    }

    const items = await getItemsForBom(db, tenantId, bomId);
    if (!items) {
      return NextResponse.json({ error: "BOM not found" }, { status: 404 });
    }

    // `seen` guards against a linkedBomId cycle (A → B → A), which would
    // otherwise recurse until MAX_DEPTH while duplicating every row.
    const allRows: { prefix: string; item: BomItemRow; depth: number }[] = [];
    const seen = new Set<string>([bomId]);

    async function flatten(bomItems: BomItemRow[], prefix: string, depth: number) {
      for (const item of bomItems) {
        allRows.push({ prefix, item, depth });
        if (!item.linkedBomId || depth >= MAX_DEPTH) continue;
        if (seen.has(item.linkedBomId)) continue;
        seen.add(item.linkedBomId);
        const subItems = await getItemsForBom(db, tenantId, item.linkedBomId);
        if (!subItems) continue;
        await flatten(subItems, `${prefix}${item.itemNumber}.`, depth + 1);
      }
    }
    await flatten(items, "", 0);

    const rows = allRows.map(({ prefix, item, depth }) => {
      const f = item.file as unknown as FileInfo | null;
      const p = item.part as unknown as PartInfo | null;
      return [
        `${prefix}${item.itemNumber}`,
        item.partNumber || p?.partNumber || f?.partNumber || "",
        item.name,
        item.description || "",
        item.quantity,
        item.unit,
        depth + 1,
        item.material || "",
        item.vendor || "",
        item.unitCost != null ? item.unitCost.toFixed(2) : "",
        p?.category || "",
        f?.name || "",
        f?.revision || "",
        f?.lifecycleState || "",
      ];
    });

    return new NextResponse(toCsv(HEADERS, rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeCsvFilename(bom.name as string)}"`,
      },
    });
  } catch (err) {
    console.error("GET /api/boms/[bomId]/export failed:", err);
    return NextResponse.json({ error: "Failed to export BOM" }, { status: 500 });
  }
}
