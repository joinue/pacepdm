import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { notify, sideEffect } from "@/lib/notifications";
import { BOM_STATUS_FLOW, BOM_STATUS_LABELS } from "@/lib/status-flows";
import { captureBomSnapshot } from "@/lib/bom-snapshot";
import { z, parseBody } from "@/lib/validation";

// Partial-update shape: any of name/status/revision can be supplied. The
// state-transition rule (only valid next-states allowed) is enforced after
// parse against the shared BOM_STATUS_FLOW map.
const UpdateBomSchema = z.object({
  name: z.string().trim().min(1).optional(),
  status: z.string().optional(),
  revision: z.string().optional(),
}).refine(
  (v) => v.name !== undefined || v.status !== undefined || v.revision !== undefined,
  { message: "At least one field is required" }
);

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ bomId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { bomId } = await params;
    const db = getServiceClient();

    const { data: bom } = await db
      .from("boms")
      .select("*")
      .eq("id", bomId)
      .eq("tenantId", tenantUser.tenantId)
      .single();

    if (!bom) {
      return NextResponse.json({ error: "BOM not found" }, { status: 404 });
    }

    return NextResponse.json(bom);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch BOM";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ bomId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, UpdateBomSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const { bomId } = await params;
    const db = getServiceClient();

    // Verify ownership
    const { data: existing } = await db
      .from("boms")
      .select("status, name, createdById")
      .eq("id", bomId)
      .eq("tenantId", tenantUser.tenantId)
      .single();

    if (!existing) {
      return NextResponse.json({ error: "BOM not found" }, { status: 404 });
    }

    const updates: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };
    const changes: Record<string, string | null> = {};

    // Name update
    if (body.name !== undefined && body.name !== existing.name) {
      updates.name = body.name;
      changes.name = body.name;
    }

    // Status transition — guarded by the shared state machine
    if (body.status && body.status !== existing.status) {
      const allowed = BOM_STATUS_FLOW[existing.status] || [];
      if (!allowed.includes(body.status)) {
        return NextResponse.json(
          { error: `Cannot change status from ${existing.status} to ${body.status}. Allowed: ${allowed.join(", ") || "none"}` },
          { status: 400 }
        );
      }
      updates.status = body.status;
      changes.status = `${existing.status} → ${body.status}`;
    }

    // Revision update
    if (body.revision !== undefined) {
      updates.revision = body.revision;
      changes.revision = body.revision;
    }

    const { data: bom, error } = await db
      .from("boms")
      .update(updates)
      .eq("id", bomId)
      .select()
      .single();

    if (error) throw error;

    // Auto-capture a baseline when the BOM transitions to RELEASED.
    // This is the "immutable record of what we shipped" that the ECO
    // trail deliberately doesn't carry — ECOs track files, not BOMs, so
    // without this snapshot a later revision of the BOM would silently
    // overwrite the picture. Failures are logged but non-fatal: a missed
    // baseline is a documentation gap, not a correctness problem, and
    // we don't want to block the release on it.
    if (updates.status === "RELEASED") {
      try {
        const result = await captureBomSnapshot({
          db,
          tenantId: tenantUser.tenantId,
          bomId,
          userId: tenantUser.id,
          trigger: "RELEASE",
        });
        console.info(
          `[boms/${bomId}] auto-baseline captured ${result.snapshotId} ` +
            `(${result.itemCount} items, $${result.flatTotalCost.toFixed(2)})`
        );
      } catch (err) {
        console.error(`[boms/${bomId}] baseline capture failed:`, err);
      }
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "bom.update",
      entityType: "bom",
      entityId: bomId,
      details: changes,
    });

    // Notify the BOM creator on status transitions. Only fires when the
    // status actually changed (not on bare name/revision edits) — those
    // are noisy and the audit log already covers them.
    if (updates.status && existing.createdById) {
      const friendlyStatus = BOM_STATUS_LABELS[body.status!] || body.status!;
      await sideEffect(
        notify({
          tenantId: tenantUser.tenantId,
          userIds: [existing.createdById],
          title: `BOM moved to ${friendlyStatus}`,
          message: `${tenantUser.fullName} moved "${existing.name}" to ${friendlyStatus}`,
          type: "transition",
          link: `/boms/${bomId}`,
          refId: bomId,
          actorId: tenantUser.id,
        }),
        `notify BOM ${bomId} status change`
      );
    }

    return NextResponse.json(bom);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update BOM";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ bomId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { bomId } = await params;
    const db = getServiceClient();

    // Verify ownership and get name for audit
    const { data: existing } = await db
      .from("boms")
      .select("name, status")
      .eq("id", bomId)
      .eq("tenantId", tenantUser.tenantId)
      .single();

    if (!existing) {
      return NextResponse.json({ error: "BOM not found" }, { status: 404 });
    }

    if (existing.status === "RELEASED") {
      return NextResponse.json(
        { error: "Cannot delete a released BOM. Obsolete it first." },
        { status: 400 }
      );
    }

    // CASCADE will delete bom_items
    const { error } = await db.from("boms").delete().eq("id", bomId);
    if (error) throw error;

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "bom.delete",
      entityType: "bom",
      entityId: bomId,
      details: { name: existing.name },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete BOM";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
