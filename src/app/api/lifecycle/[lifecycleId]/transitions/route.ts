import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { v4 as uuid } from "uuid";
import { logAudit } from "@/lib/audit";
import { z, parseBody, nonEmptyString } from "@/lib/validation";

const CreateTransitionSchema = z.object({
  fromStateId: nonEmptyString,
  toStateId: nonEmptyString,
  name: nonEmptyString,
  requiresApproval: z.boolean().optional(),
});

const DeleteTransitionSchema = z.object({ transitionId: nonEmptyString });

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ lifecycleId: string }> }
) {
  try {
    await getApiTenantUser();
    const { lifecycleId } = await params;
    const { searchParams } = new URL(request.url);
    const fromState = searchParams.get("fromState");

    if (!fromState) {
      return NextResponse.json({ error: "fromState is required" }, { status: 400 });
    }

    const db = getServiceClient();

    // Get the state ID for the current state name
    const { data: stateRow } = await db
      .from("lifecycle_states")
      .select("id")
      .eq("lifecycleId", lifecycleId)
      .eq("name", fromState)
      .single();

    if (!stateRow) {
      return NextResponse.json([]);
    }

    const { data: transitions } = await db
      .from("lifecycle_transitions")
      .select("id, name, toState:lifecycle_states!lifecycle_transitions_toStateId_fkey(name)")
      .eq("lifecycleId", lifecycleId)
      .eq("fromStateId", stateRow.id);

    return NextResponse.json(transitions || []);
  } catch (err) {
    console.error("Failed to fetch transitions:", err);
    const message = err instanceof Error ? err.message : "Failed to fetch transitions";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ lifecycleId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.ADMIN_LIFECYCLE)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, CreateTransitionSchema);
    if (!parsed.ok) return parsed.response;
    const { fromStateId, toStateId, name, requiresApproval } = parsed.data;

    const { lifecycleId } = await params;
    const db = getServiceClient();

    // Verify lifecycle belongs to tenant
    const { data: lifecycle } = await db
      .from("lifecycles")
      .select("id")
      .eq("id", lifecycleId)
      .eq("tenantId", tenantUser.tenantId)
      .single();

    if (!lifecycle) {
      return NextResponse.json({ error: "Lifecycle not found" }, { status: 404 });
    }

    // Verify both states belong to this lifecycle
    const { data: states } = await db
      .from("lifecycle_states")
      .select("id")
      .eq("lifecycleId", lifecycleId)
      .in("id", [fromStateId, toStateId]);

    if (!states || states.length < 2) {
      return NextResponse.json(
        { error: "One or both states not found in this lifecycle" },
        { status: 400 }
      );
    }

    const { data: transition, error } = await db
      .from("lifecycle_transitions")
      .insert({
        id: uuid(),
        lifecycleId,
        fromStateId,
        toStateId,
        name,
        requiresApproval: !!requiresApproval,
        approvalRoles: [],
      })
      .select()
      .single();

    if (error) throw error;

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "lifecycle_transition.create", entityType: "lifecycle_transition",
      entityId: transition.id, details: { name, lifecycleId },
    });

    return NextResponse.json(transition);
  } catch (err) {
    console.error("Failed to create transition:", err);
    const message = err instanceof Error ? err.message : "Failed to create transition";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ lifecycleId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.ADMIN_LIFECYCLE)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, DeleteTransitionSchema);
    if (!parsed.ok) return parsed.response;
    const { transitionId } = parsed.data;

    const { lifecycleId } = await params;
    const db = getServiceClient();

    // Verify lifecycle belongs to tenant
    const { data: lifecycle } = await db
      .from("lifecycles")
      .select("id")
      .eq("id", lifecycleId)
      .eq("tenantId", tenantUser.tenantId)
      .single();

    if (!lifecycle) {
      return NextResponse.json({ error: "Lifecycle not found" }, { status: 404 });
    }

    await db
      .from("lifecycle_transitions")
      .delete()
      .eq("id", transitionId)
      .eq("lifecycleId", lifecycleId);

    await logAudit({ tenantId: tenantUser.tenantId, userId: tenantUser.id, action: "lifecycle_transition.delete", entityType: "lifecycle_transition", entityId: transitionId, details: { lifecycleId } });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Failed to delete transition:", err);
    const message = err instanceof Error ? err.message : "Failed to delete transition";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
