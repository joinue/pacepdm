import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { notify, notifyApprovalGroupMembers, sideEffect } from "@/lib/notifications";
import { startWorkflow, findWorkflowForTrigger } from "@/lib/approval-engine";
import { v4 as uuid } from "uuid";
import { z, parseBody, nonEmptyString } from "@/lib/validation";

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

    // 1. Check for a workflow assignment (new system)
    const workflow = await findWorkflowForTrigger({
      tenantId: tenantUser.tenantId,
      transitionId,
    });

    if (workflow) {
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
      });

      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }

      return NextResponse.json(result);
    }

    // 2. Fall back to legacy transition_approval_rules
    const { data: approvalRules } = await db
      .from("transition_approval_rules")
      .select("*, group:approval_groups!transition_approval_rules_groupId_fkey(id, name)")
      .eq("transitionId", transitionId)
      .order("sortOrder");

    if (approvalRules && approvalRules.length > 0) {
      const now = new Date().toISOString();
      const requestId = uuid();

      await db.from("approval_requests").insert({
        id: requestId,
        tenantId: tenantUser.tenantId,
        type: "FILE_TRANSITION",
        entityType: "file",
        entityId: fileId,
        transitionId,
        requestedById: tenantUser.id,
        status: "PENDING",
        title: `${transition.name}: ${file.name}`,
        description: `Transition "${file.name}" from ${transition.fromState.name} to ${transition.toState.name}`,
        createdAt: now,
        updatedAt: now,
      });

      for (const rule of approvalRules) {
        await db.from("approval_decisions").insert({
          id: uuid(),
          requestId,
          groupId: rule.groupId,
          status: "PENDING",
          createdAt: now,
        });
      }

      await logAudit({
        tenantId: tenantUser.tenantId, userId: tenantUser.id,
        action: "file.transition.requested",
        entityType: "file", entityId: fileId,
        details: { name: file.name, from: transition.fromState.name, to: transition.toState.name, transition: transition.name },
      });

      await notifyApprovalGroupMembers({
        tenantId: tenantUser.tenantId,
        groupIds: approvalRules.map((r) => r.groupId),
        title: "Approval Required",
        message: `${tenantUser.fullName} requests approval to ${transition.name}: "${file.name}"`,
        link: "/approvals",
      });

      return NextResponse.json({
        success: true,
        pendingApproval: true,
        message: `Approval requested from: ${approvalRules.map((r) => r.group.name).join(", ")}`,
      });
    }

    // 3. No approval needed — execute immediately
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

    // Notify tenant users about significant state changes (Released, Obsolete)
    const significantStates = ["Released", "Obsolete"];
    if (significantStates.includes(toStateName)) {
      const { data: tenantUsers } = await db
        .from("tenant_users")
        .select("id")
        .eq("tenantId", tenantUser.tenantId)
        .neq("id", tenantUser.id);

      const userIds = (tenantUsers || []).map((u) => u.id);
      if (userIds.length > 0) {
        await sideEffect(
          notify({
            tenantId: tenantUser.tenantId,
            userIds,
            title: `File ${toStateName.toLowerCase()}`,
            message: `${tenantUser.fullName} moved "${file.name}" to ${toStateName}`,
            type: "transition",
            link: `/vault?file=${fileId}`,
          }),
          `notify tenant about transition of file ${fileId} to ${toStateName}`
        );
      }
    }

    return NextResponse.json({ success: true, newState: transition.toState.name });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to transition file";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
