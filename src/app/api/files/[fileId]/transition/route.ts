import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getCurrentTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { v4 as uuid } from "uuid";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const tenantUser = await getCurrentTenantUser();
    const permissions = tenantUser.role.permissions as string[];
    const { fileId } = await params;

    if (!hasPermission(permissions, PERMISSIONS.FILE_TRANSITION)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const db = getServiceClient();
    const { transitionId } = await request.json();

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

    // Check if this transition has approval rules
    const { data: approvalRules } = await db
      .from("transition_approval_rules")
      .select("*, group:approval_groups!transition_approval_rules_groupId_fkey(id, name)")
      .eq("transitionId", transitionId)
      .order("sortOrder");

    if (approvalRules && approvalRules.length > 0) {
      // Create an approval request
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

      // Create a decision entry for each required approval group
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
        tenantId: tenantUser.tenantId,
        userId: tenantUser.id,
        action: "file.transition.requested",
        entityType: "file",
        entityId: fileId,
        details: {
          name: file.name,
          from: transition.fromState.name,
          to: transition.toState.name,
          transition: transition.name,
        },
      });

      return NextResponse.json({
        success: true,
        pendingApproval: true,
        message: `Approval requested from: ${approvalRules.map((r) => r.group.name).join(", ")}`,
      });
    }

    // No approval needed — execute immediately
    await db.from("files").update({
      lifecycleState: transition.toState.name,
      updatedAt: new Date().toISOString(),
    }).eq("id", fileId);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "file.transition",
      entityType: "file",
      entityId: fileId,
      details: {
        name: file.name,
        from: transition.fromState.name,
        to: transition.toState.name,
        transition: transition.name,
      },
    });

    return NextResponse.json({ success: true, newState: transition.toState.name });
  } catch {
    return NextResponse.json({ error: "Failed to transition file" }, { status: 500 });
  }
}
