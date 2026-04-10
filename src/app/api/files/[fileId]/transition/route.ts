import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { notifyFileTransition, sideEffect } from "@/lib/notifications";
import { startWorkflow, findWorkflowForTrigger } from "@/lib/approval-engine";
import { z, parseBody, nonEmptyString } from "@/lib/validation";
import { requireFileAccess } from "@/lib/folder-access-guards";

const TransitionSchema = z.object({ transitionId: nonEmptyString });

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    const { fileId } = await params;

    if (!hasPermission(permissions, PERMISSIONS.FILE_TRANSITION)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, TransitionSchema);
    if (!parsed.ok) return parsed.response;
    const { transitionId } = parsed.data;

    const db = getServiceClient();

    const { data: file } = await db.from("files").select("*").eq("id", fileId).single();
    if (!file || file.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const access = await requireFileAccess(tenantUser, file, "edit");
    if (!access.ok) return access.response;

    if (file.isCheckedOut) {
      return NextResponse.json({ error: "Cannot transition a checked-out file" }, { status: 409 });
    }

    const { data: transition } = await db
      .from("lifecycle_transitions")
      .select("*, fromState:lifecycle_states!lifecycle_transitions_fromStateId_fkey(name), toState:lifecycle_states!lifecycle_transitions_toStateId_fkey(name)")
      .eq("id", transitionId)
      .single();

    if (!transition) {
      return NextResponse.json({ error: "Invalid transition" }, { status: 400 });
    }

    if (transition.fromState.name !== file.lifecycleState) {
      return NextResponse.json({ error: "Transition not valid from current state" }, { status: 400 });
    }

    // Workflow gate: if a workflow is assigned to this transition, route
    // the request through the engine. Otherwise the transition fires
    // directly. Every requiresApproval=true transition gets a default
    // workflow on tenant creation (see /api/tenants/route.ts) so the
    // "no workflow on a gated transition" case is essentially extinct.
    const workflow = await findWorkflowForTrigger({
      tenantId: tenantUser.tenantId,
      transitionId,
    });

    if (workflow) {
      // Idempotency-Key (RFC draft) — clients send the same key on
      // retries so a network blip can't create a second approval
      // request. Engine de-dupes via a unique index on
      // (tenantId, clientRequestKey).
      const idempotencyKey = request.headers.get("idempotency-key") || undefined;

      const result = await startWorkflow({
        tenantId: tenantUser.tenantId,
        userId: tenantUser.id,
        userFullName: tenantUser.fullName,
        workflowId: workflow.id,
        type: "FILE_TRANSITION",
        entityType: "file",
        entityId: fileId,
        transitionId,
        title: `${transition.name}: ${file.name}`,
        description: `Transition "${file.name}" from ${transition.fromState.name} to ${transition.toState.name}`,
        clientRequestKey: idempotencyKey,
      });

      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }

      return NextResponse.json(result);
    }

    // No workflow — execute immediately
    const toStateName = transition.toState.name;
    const updateData: Record<string, unknown> = {
      lifecycleState: toStateName,
      updatedAt: new Date().toISOString(),
    };

    if (toStateName === "Released") updateData.isFrozen = true;
    if (transition.fromState.name === "Released" && toStateName === "WIP") {
      const nextRevision = String.fromCharCode(file.revision.charCodeAt(0) + 1);
      updateData.revision = nextRevision;
      updateData.isFrozen = false;
    }
    if (toStateName === "Obsolete") updateData.isFrozen = true;

    await db.from("files").update(updateData).eq("id", fileId);

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "file.transition",
      entityType: "file", entityId: fileId,
      details: { name: file.name, from: transition.fromState.name, to: transition.toState.name, transition: transition.name },
    });

    await sideEffect(
      notifyFileTransition({
        tenantId: tenantUser.tenantId,
        fileId,
        fileName: file.name,
        toStateName,
        actorId: tenantUser.id,
        actorFullName: tenantUser.fullName,
        createdById: file.createdById ?? null,
      }),
      `notify about transition of file ${fileId} to ${toStateName}`
    );

    return NextResponse.json({ success: true, newState: transition.toState.name });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to transition file";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
