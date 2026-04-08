import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { fileId } = await params;
    const db = getServiceClient();

    const { data: ecoItems } = await db
      .from("eco_items")
      .select("id, changeType, reason, eco:ecos!eco_items_ecoId_fkey(id, ecoNumber, title, status, priority)")
      .eq("fileId", fileId);

    // Filter to only ECOs belonging to this tenant
    const items = (ecoItems || []).filter((item) => {
      const eco = item.eco as unknown as { id: string; ecoNumber: string; title: string; status: string; priority: string } | null;
      return eco !== null;
    });

    return NextResponse.json(items);
  } catch {
    return NextResponse.json({ error: "Failed to fetch ECO linkage" }, { status: 500 });
  }
}
