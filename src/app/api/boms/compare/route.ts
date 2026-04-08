import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";

interface BomItemRow {
  id: string;
  itemNumber: string;
  partNumber: string | null;
  name: string;
  quantity: number;
  unit: string;
  unitCost: number | null;
  material: string | null;
  vendor: string | null;
}

export async function GET(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { searchParams } = new URL(request.url);
    const bomAId = searchParams.get("a");
    const bomBId = searchParams.get("b");

    if (!bomAId || !bomBId) {
      return NextResponse.json({ error: "Both BOM IDs (a, b) are required" }, { status: 400 });
    }

    const db = getServiceClient();

    // Verify both BOMs belong to tenant
    const [{ data: bomA }, { data: bomB }] = await Promise.all([
      db.from("boms").select("id, name, revision, status").eq("id", bomAId).eq("tenantId", tenantUser.tenantId).single(),
      db.from("boms").select("id, name, revision, status").eq("id", bomBId).eq("tenantId", tenantUser.tenantId).single(),
    ]);

    if (!bomA || !bomB) {
      return NextResponse.json({ error: "One or both BOMs not found" }, { status: 404 });
    }

    const [{ data: itemsA }, { data: itemsB }] = await Promise.all([
      db.from("bom_items").select("id, itemNumber, partNumber, name, quantity, unit, unitCost, material, vendor").eq("bomId", bomAId).order("sortOrder"),
      db.from("bom_items").select("id, itemNumber, partNumber, name, quantity, unit, unitCost, material, vendor").eq("bomId", bomBId).order("sortOrder"),
    ]);

    const a = (itemsA || []) as BomItemRow[];
    const b = (itemsB || []) as BomItemRow[];

    // Match items by itemNumber (primary) or name (fallback)
    const bByItem = new Map(b.map((i) => [i.itemNumber, i]));
    const bByName = new Map(b.map((i) => [i.name, i]));
    const matchedBIds = new Set<string>();

    const changes: {
      type: "added" | "removed" | "changed" | "unchanged";
      itemNumber: string;
      name: string;
      a: BomItemRow | null;
      b: BomItemRow | null;
      diffs: string[];
    }[] = [];

    for (const itemA of a) {
      const itemB = bByItem.get(itemA.itemNumber) || bByName.get(itemA.name) || null;
      if (itemB) {
        matchedBIds.add(itemB.id);
        const diffs: string[] = [];
        if (itemA.quantity !== itemB.quantity) diffs.push(`qty: ${itemA.quantity} → ${itemB.quantity}`);
        if (itemA.unitCost !== itemB.unitCost) diffs.push(`cost: ${itemA.unitCost ?? "—"} → ${itemB.unitCost ?? "—"}`);
        if (itemA.partNumber !== itemB.partNumber) diffs.push(`pn: ${itemA.partNumber || "—"} → ${itemB.partNumber || "—"}`);
        if (itemA.material !== itemB.material) diffs.push(`material: ${itemA.material || "—"} → ${itemB.material || "—"}`);
        if (itemA.vendor !== itemB.vendor) diffs.push(`vendor: ${itemA.vendor || "—"} → ${itemB.vendor || "—"}`);
        if (itemA.name !== itemB.name) diffs.push(`name: ${itemA.name} → ${itemB.name}`);

        changes.push({
          type: diffs.length > 0 ? "changed" : "unchanged",
          itemNumber: itemA.itemNumber,
          name: itemA.name,
          a: itemA,
          b: itemB,
          diffs,
        });
      } else {
        changes.push({ type: "removed", itemNumber: itemA.itemNumber, name: itemA.name, a: itemA, b: null, diffs: [] });
      }
    }

    // Items in B that weren't matched
    for (const itemB of b) {
      if (!matchedBIds.has(itemB.id)) {
        changes.push({ type: "added", itemNumber: itemB.itemNumber, name: itemB.name, a: null, b: itemB, diffs: [] });
      }
    }

    const totalA = a.reduce((s, i) => s + (i.unitCost || 0) * i.quantity, 0);
    const totalB = b.reduce((s, i) => s + (i.unitCost || 0) * i.quantity, 0);

    return NextResponse.json({
      bomA: { ...bomA, itemCount: a.length, totalCost: totalA },
      bomB: { ...bomB, itemCount: b.length, totalCost: totalB },
      changes,
      summary: {
        added: changes.filter((c) => c.type === "added").length,
        removed: changes.filter((c) => c.type === "removed").length,
        changed: changes.filter((c) => c.type === "changed").length,
        unchanged: changes.filter((c) => c.type === "unchanged").length,
      },
    });
  } catch {
    return NextResponse.json({ error: "Failed to compare BOMs" }, { status: 500 });
  }
}
