import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { z, parseBody, optionalString } from "@/lib/validation";

const UpdateGroupSchema = z.object({
  name: z.string().trim().min(1).optional(),
  description: optionalString,
  isActive: z.boolean().optional(),
}).refine(
  (v) => v.name !== undefined || v.description !== undefined || v.isActive !== undefined,
  { message: "At least one field is required" }
);

/**
 * Soft vs. hard delete: a group is an audit-trail anchor. If anything
 * still references it (a workflow step, a historical decision), the
 * group is archived (`isActive = false`) so the linkage stays
 * resolvable. Only never-used groups are removed outright.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ groupId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.ADMIN_SETTINGS)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { groupId } = await params;
    const db = getServiceClient();

    const { data: group } = await db
      .from("approval_groups")
      .select("id, tenantId, name")
      .eq("id", groupId)
      .single();
    if (!group || group.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const [{ count: stepRefs }, { count: decisionRefs }] = await Promise.all([
      db.from("approval_workflow_steps")
        .select("*", { count: "exact", head: true })
        .eq("groupId", groupId),
      db.from("approval_decisions")
        .select("*", { count: "exact", head: true })
        .eq("groupId", groupId),
    ]);

    const inUse = (stepRefs ?? 0) > 0 || (decisionRefs ?? 0) > 0;

    if (inUse) {
      // Archive — preserves audit trail, removes from group pickers.
      await db.from("approval_groups")
        .update({ isActive: false, updatedAt: new Date().toISOString() })
        .eq("id", groupId);

      await logAudit({
        tenantId: tenantUser.tenantId,
        userId: tenantUser.id,
        action: "approval_group.archive",
        entityType: "approval_group",
        entityId: groupId,
        details: { name: group.name, stepRefs, decisionRefs },
      });

      return NextResponse.json({
        success: true,
        archived: true,
        message: `Group archived — still referenced by ${stepRefs ?? 0} workflow step(s) and ${decisionRefs ?? 0} historical decision(s).`,
      });
    }

    // Pristine — safe to remove.
    await db.from("approval_group_members").delete().eq("groupId", groupId);
    await db.from("approval_groups").delete().eq("id", groupId);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "approval_group.delete",
      entityType: "approval_group",
      entityId: groupId,
      details: { name: group.name },
    });

    return NextResponse.json({ success: true, archived: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete group";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Edit group fields, including archive (isActive=false) and restore (isActive=true). */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ groupId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.ADMIN_SETTINGS)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, UpdateGroupSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const { groupId } = await params;
    const db = getServiceClient();

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.isActive !== undefined) updates.isActive = body.isActive;

    const { data, error } = await db
      .from("approval_groups")
      .update(updates)
      .eq("id", groupId)
      .eq("tenantId", tenantUser.tenantId)
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: "A group with this name already exists" }, { status: 409 });
      }
      throw error;
    }
    if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: body.isActive === true ? "approval_group.restore" : "approval_group.update",
      entityType: "approval_group",
      entityId: groupId,
      details: { name: data.name },
    });

    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update group";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
