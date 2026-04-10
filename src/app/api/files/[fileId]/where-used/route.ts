import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";
import { requireFileAccess } from "@/lib/folder-access-guards";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { fileId } = await params;
    const db = getServiceClient();

    const { data: file } = await db
      .from("files")
      .select("id, tenantId, folderId")
      .eq("id", fileId)
      .single();
    if (!file || file.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
    const access = await requireFileAccess(tenantUser, file, "view");
    if (!access.ok) return access.response;

    // Find all BOM items that reference this file, and join the parent BOM
    const { data: items } = await db
      .from("bom_items")
      .select("id, itemNumber, name, quantity, unit, bom:boms!bom_items_bomId_fkey(id, name, revision, status, tenantId)")
      .eq("fileId", fileId);

    // Filter to current tenant and reshape
    const results = (items || [])
      .filter((item) => {
        const bom = item.bom as unknown as { tenantId: string } | null;
        return bom && bom.tenantId === tenantUser.tenantId;
      })
      .map((item) => {
        const bom = item.bom as unknown as { id: string; name: string; revision: string; status: string };
        return {
          itemId: item.id,
          itemNumber: item.itemNumber,
          itemName: item.name,
          quantity: item.quantity,
          unit: item.unit,
          bomId: bom.id,
          bomName: bom.name,
          bomRevision: bom.revision,
          bomStatus: bom.status,
        };
      });

    return NextResponse.json(results);
  } catch {
    return NextResponse.json({ error: "Failed to fetch where-used data" }, { status: 500 });
  }
}
