import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { z, parseBody, nonEmptyString } from "@/lib/validation";

const BulkTransitionSchema = z.object({
  fileIds: z.array(nonEmptyString).min(1, "At least one fileId is required"),
  transitionId: nonEmptyString,
});

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];

    if (!hasPermission(permissions, PERMISSIONS.FILE_TRANSITION)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, BulkTransitionSchema);
    if (!parsed.ok) return parsed.response;
    const { fileIds, transitionId } = parsed.data;

    const db = getServiceClient();

    const { data: transition } = await db
      .from("lifecycle_transitions")
      .select("*, fromState:lifecycle_states!lifecycle_transitions_fromStateId_fkey(name), toState:lifecycle_states!lifecycle_transitions_toStateId_fkey(name)")
      .eq("id", transitionId)
      .single();

    if (!transition) {
      return NextResponse.json({ error: "Invalid transition" }, { status: 400 });
    }

    // Check for approval rules
    const { data: approvalRules } = await db
      .from("transition_approval_rules")
      .select("id")
      .eq("transitionId", transitionId);

    if (approvalRules && approvalRules.length > 0) {
      return NextResponse.json({
        error: "This transition requires approval. Transition files individually.",
      }, { status: 400 });
    }

    const now = new Date().toISOString();
    let transitioned = 0;
    const errors: string[] = [];

    for (const fileId of fileIds) {
      const { data: file } = await db.from("files").select("*").eq("id", fileId).single();

      if (!file || file.tenantId !== tenantUser.tenantId) {
        errors.push(`File ${fileId}: not found`);
        continue;
      }
      if (file.lifecycleState !== transition.fromState.name) {
        errors.push(`${file.name}: not in ${transition.fromState.name} state`);
        continue;
      }
      if (file.isCheckedOut) {
        errors.push(`${file.name}: checked out`);
        continue;
      }

      const updateData: Record<string, unknown> = {
        lifecycleState: transition.toState.name,
        updatedAt: now,
      };

      if (transition.toState.name === "Released") updateData.isFrozen = true;
      if (transition.fromState.name === "Released" && transition.toState.name === "WIP") {
        updateData.revision = String.fromCharCode(file.revision.charCodeAt(0) + 1);
        updateData.isFrozen = false;
      }
      if (transition.toState.name === "Obsolete") updateData.isFrozen = true;

      await db.from("files").update(updateData).eq("id", fileId);

      await logAudit({
        tenantId: tenantUser.tenantId,
        userId: tenantUser.id,
        action: "file.bulk_transition",
        entityType: "file",
        entityId: fileId,
        details: { name: file.name, from: transition.fromState.name, to: transition.toState.name },
      });

      transitioned++;
    }

    return NextResponse.json({
      success: true,
      transitioned,
      errors,
      newState: transition.toState.name,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to perform bulk transition";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
