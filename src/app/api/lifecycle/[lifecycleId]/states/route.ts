import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { v4 as uuid } from "uuid";
import { logAudit } from "@/lib/audit";

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

    const { lifecycleId } = await params;
    const { name, color, isInitial, isFinal, sortOrder } = await request.json();

    if (!name?.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

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

    // If marking as initial, unset other initial states
    if (isInitial) {
      await db
        .from("lifecycle_states")
        .update({ isInitial: false })
        .eq("lifecycleId", lifecycleId)
        .eq("isInitial", true);
    }

    // Get next sort order if not provided
    let order = sortOrder;
    if (order === undefined || order === null) {
      const { data: maxState } = await db
        .from("lifecycle_states")
        .select("sortOrder")
        .eq("lifecycleId", lifecycleId)
        .order("sortOrder", { ascending: false })
        .limit(1)
        .single();
      order = (maxState?.sortOrder ?? 0) + 1;
    }

    const { data: state, error } = await db
      .from("lifecycle_states")
      .insert({
        id: uuid(),
        lifecycleId,
        name: name.trim(),
        color: color || "#6b7280",
        isInitial: !!isInitial,
        isFinal: !!isFinal,
        sortOrder: order,
      })
      .select()
      .single();

    if (error) throw error;

    await logAudit({ tenantId: tenantUser.tenantId, userId: tenantUser.id, action: "lifecycle_state.create", entityType: "lifecycle_state", entityId: state.id, details: { name: name.trim(), lifecycleId } });

    return NextResponse.json(state);
  } catch {
    return NextResponse.json({ error: "Failed to create state" }, { status: 500 });
  }
}

export async function PUT(
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

    const { lifecycleId } = await params;
    const { stateId, name, color, isInitial, isFinal } = await request.json();

    if (!stateId) {
      return NextResponse.json({ error: "stateId is required" }, { status: 400 });
    }

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

    // If marking as initial, unset other initial states
    if (isInitial) {
      await db
        .from("lifecycle_states")
        .update({ isInitial: false })
        .eq("lifecycleId", lifecycleId)
        .eq("isInitial", true)
        .neq("id", stateId);
    }

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name.trim();
    if (color !== undefined) updates.color = color;
    if (isInitial !== undefined) updates.isInitial = isInitial;
    if (isFinal !== undefined) updates.isFinal = isFinal;

    const { data: state, error } = await db
      .from("lifecycle_states")
      .update(updates)
      .eq("id", stateId)
      .eq("lifecycleId", lifecycleId)
      .select()
      .single();

    if (error) throw error;

    await logAudit({ tenantId: tenantUser.tenantId, userId: tenantUser.id, action: "lifecycle_state.update", entityType: "lifecycle_state", entityId: stateId, details: { name: state?.name, lifecycleId } });

    return NextResponse.json(state);
  } catch {
    return NextResponse.json({ error: "Failed to update state" }, { status: 500 });
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

    const { lifecycleId } = await params;
    const { stateId } = await request.json();

    if (!stateId) {
      return NextResponse.json({ error: "stateId is required" }, { status: 400 });
    }

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

    // Check if any transitions reference this state
    const { count: transitionCount } = await db
      .from("lifecycle_transitions")
      .select("id", { count: "exact", head: true })
      .eq("lifecycleId", lifecycleId)
      .or(`fromStateId.eq.${stateId},toStateId.eq.${stateId}`);

    if (transitionCount && transitionCount > 0) {
      return NextResponse.json(
        { error: "Cannot delete: state is referenced by transitions. Remove those transitions first." },
        { status: 409 }
      );
    }

    // Check if any files are in this state
    const { count: fileCount } = await db
      .from("files")
      .select("id", { count: "exact", head: true })
      .eq("lifecycleState", stateId);

    if (fileCount && fileCount > 0) {
      return NextResponse.json(
        { error: `Cannot delete: ${fileCount} file(s) are in this state` },
        { status: 409 }
      );
    }

    await db.from("lifecycle_states").delete().eq("id", stateId);

    await logAudit({ tenantId: tenantUser.tenantId, userId: tenantUser.id, action: "lifecycle_state.delete", entityType: "lifecycle_state", entityId: stateId, details: { lifecycleId } });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete state" }, { status: 500 });
  }
}
