import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";

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

interface FileInfo { name: string; partNumber: string | null; revision: string; lifecycleState: string }
interface PartInfo { partNumber: string; name: string; category: string }

async function getItemsForBom(db: ReturnType<typeof getServiceClient>, bomId: string): Promise<BomItemRow[]> {
  const { data } = await db
    .from("bom_items")
    .select("itemNumber, partNumber, name, description, quantity, unit, level, material, vendor, unitCost, linkedBomId, file:files!bom_items_fileId_fkey(name, partNumber, revision, lifecycleState), part:parts!bom_items_partId_fkey(partNumber, name, category)")
    .eq("bomId", bomId)
    .order("sortOrder");
  return (data || []) as BomItemRow[];
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ bomId: string }> }
) {
  try {
    await getApiTenantUser();
    const { bomId } = await params;
    const db = getServiceClient();

    const { data: bom } = await db.from("boms").select("name").eq("id", bomId).single();
    const items = await getItemsForBom(db, bomId);

    if (!bom) {
      return NextResponse.json({ error: "BOM not found" }, { status: 404 });
    }

    // Flatten sub-assemblies recursively (max 5 levels deep)
    const allRows: { prefix: string; item: BomItemRow; depth: number }[] = [];
    async function flatten(bomItems: BomItemRow[], prefix: string, depth: number) {
      for (const item of bomItems) {
        allRows.push({ prefix, item, depth });
        if (item.linkedBomId && depth < 5) {
          const subItems = await getItemsForBom(db, item.linkedBomId);
          await flatten(subItems, `${prefix}${item.itemNumber}.`, depth + 1);
        }
      }
    }
    await flatten(items, "", 0);

    const headers = ["Item #", "Part Number", "Name", "Description", "Qty", "Unit", "Level", "Material", "Vendor", "Unit Cost", "Part Category", "File", "File Rev", "File State"];
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

    const csv = [
      headers.join(","),
      ...rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")),
    ].join("\n");

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="${bom.name}.csv"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "Failed to export BOM" }, { status: 500 });
  }
}
