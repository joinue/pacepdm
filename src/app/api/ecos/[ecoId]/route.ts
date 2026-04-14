import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { notify, sideEffect } from "@/lib/notifications";
import { startWorkflow, findWorkflowForTrigger } from "@/lib/approval-engine";
import { ECO_STATUS_FLOW as VALID_TRANSITIONS } from "@/lib/status-flows";
import { z, parseBody, optionalString } from "@/lib/validation";

// Update body: status transitions and field updates can be combined.
// Field updates are only allowed in DRAFT (enforced after parse). The
// state-transition rule is also enforced after parse against ECO_STATUS_FLOW.
const UpdateEcoSchema = z.object({
  status: z.string().optional(),
  title: z.string().trim().min(1).optional(),
  description: optionalString,
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  reason: optionalString,
  changeType: optionalString,
  costImpact: optionalString,
  disposition: optionalString,
  effectivity: optionalString,
}).refine(
  (v) => Object.keys(v).length > 0,
  { message: "No changes specified" }
);

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ ecoId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { ecoId } = await params;
    const db = getServiceClient();

    // maybeSingle returns (data: null, error: null) cleanly when the row
    // doesn't exist, instead of wrapping "0 rows" in an error object. That
    // lets us tell an empty result apart from an actual query failure
    // (broken join, connection drop, etc.) without parsing error codes.
    const { data: eco, error } = await db
      .from("ecos")
      .select("*, createdBy:tenant_users!ecos_createdById_fkey(fullName, email)")
      .eq("id", ecoId)
      .eq("tenantId", tenantUser.tenantId)
      .maybeSingle();

    if (error) {
      console.error(`[ecos/${ecoId}] GET failed:`, error);
      return NextResponse.json(
        { error: `Query failed: ${error.message}` },
        { status: 500 }
      );
    }
    if (!eco) return NextResponse.json({ error: "ECO not found" }, { status: 404 });

    return NextResponse.json(eco);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch ECO";
    return NextResponse.json({ error: message }, { status: 500 });
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

    const parsed = await parseBody(request, UpdateEcoSchema);
    if (!parsed.ok) return parsed.response;
    const { status, title, description, priority, reason, changeType, costImpact, disposition, effectivity } = parsed.data;

    const db = getServiceClient();

    const { data: eco } = await db.from("ecos").select("*").eq("id", ecoId).single();
    if (!eco || eco.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "ECO not found" }, { status: 404 });
    }

    const now = new Date().toISOString();

    // Field updates are only legal in DRAFT — once submitted, the content is frozen.
    const hasFieldUpdate = [title, description, priority, reason, changeType, costImpact, disposition, effectivity]
      .some((v) => v !== undefined);
    if (hasFieldUpdate) {
      if (eco.status !== "DRAFT") {
        return NextResponse.json({ error: "Can only edit fields when ECO is in DRAFT" }, { status: 400 });
      }

      const updates: Record<string, unknown> = { updatedAt: now };
      if (title !== undefined) updates.title = title;
      if (description !== undefined) updates.description = description;
      if (priority !== undefined) updates.priority = priority;
      if (reason !== undefined) updates.reason = reason;
      if (changeType !== undefined) updates.changeType = changeType;
      if (costImpact !== undefined) updates.costImpact = costImpact;
      if (disposition !== undefined) updates.disposition = disposition;
      if (effectivity !== undefined) updates.effectivity = effectivity;

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

          // Notify ECO creator (notify() filters the actor automatically).
          if (eco.createdById) {
            await sideEffect(
              notify({
                tenantId: tenantUser.tenantId,
                userIds: [eco.createdById],
                title: `ECO ${eco.ecoNumber} ${status.toLowerCase()}`,
                message: `${tenantUser.fullName} moved ${eco.ecoNumber} to ${status}`,
                type: "eco",
                link: `/ecos`,
                refId: eco.id,
                actorId: tenantUser.id,
              }),
              `notify ECO ${eco.ecoNumber} status change`
            );
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

      // Notify ECO creator (notify() filters the actor automatically).
      if (eco.createdById) {
        await sideEffect(
          notify({
            tenantId: tenantUser.tenantId,
            userIds: [eco.createdById],
            title: `ECO ${eco.ecoNumber} ${status.toLowerCase()}`,
            message: `${tenantUser.fullName} moved ${eco.ecoNumber} to ${status}`,
            type: "eco",
            link: `/ecos`,
            refId: eco.id,
            actorId: tenantUser.id,
          }),
          `notify ECO ${eco.ecoNumber} status change`
        );
      }

      return NextResponse.json(updated);
    }

    return NextResponse.json({ error: "No changes specified" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update ECO";
    return NextResponse.json({ error: message }, { status: 500 });
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
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete ECO";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
