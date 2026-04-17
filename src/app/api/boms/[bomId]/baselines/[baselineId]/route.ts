import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";

/**
 * GET /api/boms/[bomId]/baselines/[baselineId]
 *
 * Returns a single baseline with its full items + metrics payload. The
 * list endpoint deliberately omits those fields to keep the sidebar
 * list cheap, so the UI only fetches them when opening a specific
 * baseline for viewing.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ bomId: string; baselineId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { bomId, baselineId } = await params;
    const db = getServiceClient();

    // Double-scope: match both bomId and baselineId AND tenantId so a
    // crafted URL from another tenant can't read our baselines.
    const { data: snapshot, error } = await db
      .from("bom_snapshots")
      .select(
        "id, bomId, bomName, bomRevision, bomStatus, trigger, ecoId, snapshotAt, note, items, metrics, " +
          "createdBy:tenant_users!bom_snapshots_createdById_fkey(fullName)"
      )
      .eq("id", baselineId)
      .eq("bomId", bomId)
      .eq("tenantId", tenantUser.tenantId)
      .maybeSingle();

    if (error) {
      console.error(`[boms/${bomId}/baselines/${baselineId}] GET failed:`, error);
      return NextResponse.json(
        { error: `Query failed: ${error.message}` },
        { status: 500 }
      );
    }
    if (!snapshot) {
      return NextResponse.json({ error: "Baseline not found" }, { status: 404 });
    }

    return NextResponse.json(snapshot);
  } catch (err) {
    console.error("Failed to fetch baseline:", err);
    const message = err instanceof Error ? err.message : "Failed to fetch baseline";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
