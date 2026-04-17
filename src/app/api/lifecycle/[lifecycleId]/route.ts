import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { z, parseBody } from "@/lib/validation";

const UpdateLifecycleSchema = z.object({
  name: z.string().trim().min(1).optional(),
  isDefault: z.boolean().optional(),
}).refine(
  (v) => v.name !== undefined || v.isDefault !== undefined,
  { message: "At least one field is required" }
);

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

    const parsed = await parseBody(request, UpdateLifecycleSchema);
    if (!parsed.ok) return parsed.response;
    const { name, isDefault } = parsed.data;

    const { lifecycleId } = await params;
    const db = getServiceClient();
    const now = new Date().toISOString();

    // Verify lifecycle belongs to tenant
    const { data: existing } = await db
      .from("lifecycles")
      .select("id")
      .eq("id", lifecycleId)
      .eq("tenantId", tenantUser.tenantId)
      .single();

    if (!existing) {
      return NextResponse.json({ error: "Lifecycle not found" }, { status: 404 });
    }

    // If marking as default, unset other defaults first
    if (isDefault) {
      await db
        .from("lifecycles")
        .update({ isDefault: false, updatedAt: now })
        .eq("tenantId", tenantUser.tenantId)
        .eq("isDefault", true)
        .neq("id", lifecycleId);
    }

    const updates: Record<string, unknown> = { updatedAt: now };
    if (name !== undefined) updates.name = name;
    if (isDefault !== undefined) updates.isDefault = isDefault;

    const { data: lifecycle, error } = await db
      .from("lifecycles")
      .update(updates)
      .eq("id", lifecycleId)
      .select()
      .single();

    if (error) {
      if (error.code === "23505")
        return NextResponse.json({ error: "Lifecycle name already exists" }, { status: 409 });
      throw error;
    }

    await logAudit({ tenantId: tenantUser.tenantId, userId: tenantUser.id, action: "lifecycle.update", entityType: "lifecycle", entityId: lifecycleId, details: { name: lifecycle?.name } });

    return NextResponse.json(lifecycle);
  } catch (err) {
    console.error("Failed to update lifecycle:", err);
    const message = err instanceof Error ? err.message : "Failed to update lifecycle";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
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
    const db = getServiceClient();

    // Verify lifecycle belongs to tenant
    const { data: existing } = await db
      .from("lifecycles")
      .select("id")
      .eq("id", lifecycleId)
      .eq("tenantId", tenantUser.tenantId)
      .single();

    if (!existing) {
      return NextResponse.json({ error: "Lifecycle not found" }, { status: 404 });
    }

    // Check if any files use this lifecycle
    const { count } = await db
      .from("files")
      .select("id", { count: "exact", head: true })
      .eq("lifecycleId", lifecycleId);

    if (count && count > 0) {
      return NextResponse.json(
        { error: `Cannot delete: ${count} file(s) use this lifecycle` },
        { status: 409 }
      );
    }

    // Delete transitions, states, then lifecycle
    await db.from("lifecycle_transitions").delete().eq("lifecycleId", lifecycleId);
    await db.from("lifecycle_states").delete().eq("lifecycleId", lifecycleId);
    await db.from("lifecycles").delete().eq("id", lifecycleId);

    await logAudit({ tenantId: tenantUser.tenantId, userId: tenantUser.id, action: "lifecycle.delete", entityType: "lifecycle", entityId: lifecycleId });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Failed to delete lifecycle:", err);
    const message = err instanceof Error ? err.message : "Failed to delete lifecycle";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
