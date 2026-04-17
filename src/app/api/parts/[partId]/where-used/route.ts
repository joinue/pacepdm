import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";
import { getPartWhereUsed } from "@/lib/where-used";

/**
 * GET /api/parts/[partId]/where-used
 *
 * Returns a unified where-used payload for a part:
 *
 *   - `boms`          — BOMs that list this part as a line item
 *   - `parentParts`   — transitive assembly parents, discovered by
 *                       walking bom_items → boms.fileId → part_files
 *   - `linkedFiles`   — files attached to the part (part_files)
 *   - `ecos`          — ECOs that have touched the part (eco_items)
 *
 * This is purely read-only and tenant-scoped by construction (the lib
 * filters every joined row by tenantId). The part existence check here
 * is just to return 404 cleanly rather than leaking a tenant-mismatch
 * as an empty result.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ partId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { partId } = await params;
    const db = getServiceClient();

    const { data: part } = await db
      .from("parts")
      .select("id, tenantId")
      .eq("id", partId)
      .single();
    if (!part || part.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "Part not found" }, { status: 404 });
    }

    const result = await getPartWhereUsed(db, tenantUser.tenantId, partId);
    return NextResponse.json(result);
  } catch (err) {
    console.error("Failed to fetch where-used data:", err);
    const message = err instanceof Error ? err.message : "Failed to fetch where-used data";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
