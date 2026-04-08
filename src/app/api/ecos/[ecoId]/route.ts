import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { notify } from "@/lib/notifications";
import { startWorkflow, findWorkflowForTrigger } from "@/lib/approval-engine";

// Valid status transitions
const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["IN_REVIEW", "REJECTED"],
  IN_REVIEW: ["APPROVED", "REJECTED"],
  APPROVED: ["IMPLEMENTED"],
  REJECTED: ["DRAFT"],
  IMPLEMENTED: ["CLOSED"],
  CLOSED: [],
};

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ ecoId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { ecoId } = await params;
    const db = getServiceClient();

    const { data: eco } = await db
      .from("ecos")
      .select("*, createdBy:tenant_users!ecos_createdById_fkey(fullName, email)")
      .eq("id", ecoId)
      .eq("tenantId", tenantUser.tenantId)
      .single();

    if (!eco) return NextResponse.json({ error: "ECO not found" }, { status: 404 });

    return NextResponse.json(eco);
  } catch {
    return NextResponse.json({ error: "Failed to fetch ECO" }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ ecoId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    const { ecoId } = await params;

    if (!hasPermission(permissions, PERMISSIONS.ECO_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const db = getServiceClient();
    const body = await request.json();
    const { status, title, description, priority, reason, changeType, costImpact, disposition, effectivity } = body;

    const { data: eco } = await db.from("ecos").select("*").eq("id", ecoId).single();
    if (!eco || eco.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "ECO not found" }, { status: 404 });
    }

    const now = new Date().toISOString();

    // Field updates (only in DRAFT)
    const hasFieldUpdate = [title, description, priority, reason, changeType, costImpact, disposition, effectivity].some(v => v !== undefined);
    if (hasFieldUpdate) {
      if (eco.status !== "DRAFT") {
        return NextResponse.json({ error: "Can only edit fields when ECO is in DRAFT" }, { status: 400 });
      }

      const updates: Record<string, unknown> = { updatedAt: now };
      if (title !== undefined) updates.title = title.trim();
      if (description !== undefined) updates.description = description?.trim() || null;
      if (priority !== undefined) updates.priority = priority;
      if (reason !== undefined) updates.reason = reason || null;
      if (changeType !== undefined) updates.changeType = changeType || null;
      if (costImpact !== undefined) updates.costImpact = costImpact || null;
      if (disposition !== undefined) updates.disposition = disposition || null;
      if (effectivity !== undefined) updates.effectivity = effectivity?.trim() || null;

      if (!status) {
        const { data: updated, error } = await db.from("ecos").update(updates).eq("id", ecoId)
          .select("*, createdBy:tenant_users!ecos_createdById_fkey(fullName, email)").single();
        if (error) throw error;
        return NextResponse.json(updated);
      }
    }

    // Status transition
    if (status) {
      const validNext = VALID_TRANSITIONS[eco.status] || [];
      if (!validNext.includes(status)) {
        return NextResponse.json({
          error: `Cannot transition from ${eco.status} to ${status}. Valid: ${validNext.join(", ") || "none"}`,
        }, { status: 400 });
      }

      // Check for approval workflow on SUBMITTED or IN_REVIEW transitions
      if (status === "SUBMITTED" || status === "IN_REVIEW") {
        const workflow = await findWorkflowForTrigger({
          tenantId: tenantUser.tenantId,
          ecoTrigger: status,
        });

        if (workflow) {
          await db.from("ecos").update({ status, updatedAt: now }).eq("id", ecoId);

          const result = await startWorkflow({
            tenantId: tenantUser.tenantId,
            userId: tenantUser.id,
            userFullName: tenantUser.fullName,
            workflowId: workflow.id,
            type: "ECO",
            entityType: "eco",
            entityId: ecoId,
            title: `ECO ${eco.ecoNumber}: ${eco.title}`,
            description: `ECO ${eco.ecoNumber} submitted for approval`,
          });

          await logAudit({
            tenantId: tenantUser.tenantId,
            userId: tenantUser.id,
            action: "eco.status_change",
            entityType: "eco",
            entityId: ecoId,
            details: { ecoNumber: eco.ecoNumber, from: eco.status, to: status, workflowTriggered: true },
          });

          // Notify ECO creator if someone else triggered the transition
          if (eco.createdById && eco.createdById !== tenantUser.id) {
            await notify({
              tenantId: tenantUser.tenantId,
              userIds: [eco.createdById],
              title: `ECO ${eco.ecoNumber} ${status.toLowerCase()}`,
              message: `${tenantUser.fullName} moved ${eco.ecoNumber} to ${status}`,
              type: "eco",
              link: `/ecos`,
            }).catch(() => {});
          }

          const { data: updated } = await db.from("ecos")
            .select("*, createdBy:tenant_users!ecos_createdById_fkey(fullName, email)")
            .eq("id", ecoId).single();

          return NextResponse.json({
            ...updated,
            pendingApproval: result.success,
            message: result.success ? "ECO submitted for approval" : undefined,
          });
        }
      }

      // No workflow — update status directly
      const { data: updated, error } = await db.from("ecos")
        .update({ status, updatedAt: now })
        .eq("id", ecoId)
        .select("*, createdBy:tenant_users!ecos_createdById_fkey(fullName, email)")
        .single();

      if (error) throw error;

      await logAudit({
        tenantId: tenantUser.tenantId,
        userId: tenantUser.id,
        action: "eco.status_change",
        entityType: "eco",
        entityId: ecoId,
        details: { ecoNumber: eco.ecoNumber, from: eco.status, to: status },
      });

      // Notify ECO creator if someone else changed the status
      if (eco.createdById && eco.createdById !== tenantUser.id) {
        await notify({
          tenantId: tenantUser.tenantId,
          userIds: [eco.createdById],
          title: `ECO ${eco.ecoNumber} ${status.toLowerCase()}`,
          message: `${tenantUser.fullName} moved ${eco.ecoNumber} to ${status}`,
          type: "eco",
          link: `/ecos`,
        }).catch(() => {});
      }

      return NextResponse.json(updated);
    }

    return NextResponse.json({ error: "No changes specified" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Failed to update ECO" }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ ecoId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    const { ecoId } = await params;

    if (!hasPermission(permissions, PERMISSIONS.ECO_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const db = getServiceClient();

    const { data: eco } = await db.from("ecos").select("id, status, ecoNumber, tenantId").eq("id", ecoId).single();
    if (!eco || eco.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "ECO not found" }, { status: 404 });
    }

    if (eco.status !== "DRAFT" && eco.status !== "REJECTED" && eco.status !== "CLOSED") {
      return NextResponse.json({
        error: "Can only delete ECOs in DRAFT, REJECTED, or CLOSED status",
      }, { status: 400 });
    }

    // eco_items cascade-deletes via FK
    await db.from("ecos").delete().eq("id", ecoId);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "eco.delete",
      entityType: "eco",
      entityId: ecoId,
      details: { ecoNumber: eco.ecoNumber },
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete ECO" }, { status: 500 });
  }
}
