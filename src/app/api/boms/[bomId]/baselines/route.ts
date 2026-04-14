import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { captureBomSnapshot } from "@/lib/bom-snapshot";
import { z, parseBody, optionalString } from "@/lib/validation";

/**
 * GET /api/boms/[bomId]/baselines
 *
 * Returns the list of saved baselines for a BOM, newest first. The
 * response intentionally omits the `items` / `metrics` JSONB payloads
 * so the list stays cheap — fetch a specific baseline through the
 * `[baselineId]` endpoint to get its full contents.
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

    // Verify tenant ownership first — we return 404 instead of an empty
    // list so a cross-tenant request can't be used to probe for BOM ids.
    const { data: bom } = await db
      .from("boms")
      .select("id, tenantId")
      .eq("id", bomId)
      .maybeSingle();
    if (!bom || bom.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "BOM not found" }, { status: 404 });
    }

    const { data: snapshots, error } = await db
      .from("bom_snapshots")
      .select(
        "id, bomName, bomRevision, bomStatus, trigger, ecoId, snapshotAt, createdById, note, metrics, " +
          "createdBy:tenant_users!bom_snapshots_createdById_fkey(fullName)"
      )
      .eq("bomId", bomId)
      .eq("tenantId", tenantUser.tenantId)
      .order("snapshotAt", { ascending: false });

    if (error) {
      console.error(`[boms/${bomId}/baselines] GET failed:`, error);
      return NextResponse.json(
        { error: `Query failed: ${error.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json(snapshots ?? []);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch baselines";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

const CreateBaselineSchema = z.object({
  note: optionalString,
});

/**
 * POST /api/boms/[bomId]/baselines
 *
 * Manually capture a baseline for a BOM in its current state. Accepts
 * an optional human-readable note ("pre-pilot freeze", "handed off to
 * CM"). Requires FILE_EDIT because capturing a baseline is a change to
 * the audit record even though it doesn't touch the BOM itself.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ bomId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, CreateBaselineSchema);
    if (!parsed.ok) return parsed.response;

    const { bomId } = await params;
    const db = getServiceClient();

    const { data: bom } = await db
      .from("boms")
      .select("id, tenantId, name")
      .eq("id", bomId)
      .maybeSingle();
    if (!bom || bom.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "BOM not found" }, { status: 404 });
    }

    const result = await captureBomSnapshot({
      db,
      tenantId: tenantUser.tenantId,
      bomId,
      userId: tenantUser.id,
      trigger: "MANUAL",
      note: parsed.data.note ?? null,
    });

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "bom.baseline.create",
      entityType: "bom",
      entityId: bomId,
      details: {
        snapshotId: result.snapshotId,
        itemCount: result.itemCount,
        flatTotalCost: result.flatTotalCost,
        note: parsed.data.note ?? null,
      },
    });

    return NextResponse.json({
      snapshotId: result.snapshotId,
      itemCount: result.itemCount,
      flatTotalCost: result.flatTotalCost,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to capture baseline";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
