import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, permissionsExceedingActor, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { z, parseBody, optionalString } from "@/lib/validation";

const UpdateRoleSchema = z.object({
  name: z.string().trim().min(1).optional(),
  description: optionalString,
  permissions: z.array(z.string()).optional(),
});

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ roleId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const perms = tenantUser.role.permissions as string[];
    if (!hasPermission(perms, PERMISSIONS.ADMIN_ROLES)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, UpdateRoleSchema);
    if (!parsed.ok) return parsed.response;
    const { name, description, permissions } = parsed.data;

    const { roleId } = await params;
    const db = getServiceClient();

    const { data: role } = await db.from("roles").select("*").eq("id", roleId).single();
    if (!role || role.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // System roles (Admin / Engineer / Viewer) are part of the
    // application's contract — neutering Admin's permissions would
    // brick the workspace. DELETE already blocks them; PUT needs the
    // same fence so an ADMIN_ROLES holder can't strip "*" from Admin.
    if (role.isSystem) {
      return NextResponse.json({ error: "Cannot edit system roles" }, { status: 400 });
    }

    // Privilege ceiling — same reason as POST in /api/roles. You can
    // only assign permissions you yourself hold.
    if (permissions !== undefined) {
      const excess = permissionsExceedingActor(permissions, perms);
      if (excess.length > 0) {
        return NextResponse.json(
          { error: `Cannot grant permissions you don't hold: ${excess.join(", ")}` },
          { status: 403 }
        );
      }
    }

    await db.from("roles").update({
      name: name ?? role.name,
      description: description ?? role.description,
      permissions: permissions ?? role.permissions,
      updatedAt: new Date().toISOString(),
    }).eq("id", roleId);

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "role.update", entityType: "role",
      entityId: roleId, details: { name: name ?? role.name },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Failed to update role:", err);
    const message = err instanceof Error ? err.message : "Failed to update role";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ roleId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const perms = tenantUser.role.permissions as string[];
    if (!hasPermission(perms, PERMISSIONS.ADMIN_ROLES)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { roleId } = await params;
    const db = getServiceClient();

    const { data: role } = await db.from("roles").select("*").eq("id", roleId).single();
    if (!role || role.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (role.isSystem) {
      return NextResponse.json({ error: "Cannot delete system roles" }, { status: 400 });
    }

    // Check if anyone is using this role
    const { count } = await db.from("tenant_users").select("*", { count: "exact", head: true }).eq("roleId", roleId);
    if (count && count > 0) {
      return NextResponse.json({ error: "Cannot delete a role that has users assigned to it" }, { status: 409 });
    }

    await db.from("roles").delete().eq("id", roleId);

    await logAudit({ tenantId: tenantUser.tenantId, userId: tenantUser.id, action: "role.delete", entityType: "role", entityId: roleId, details: { name: role.name } });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Failed to delete role:", err);
    const message = err instanceof Error ? err.message : "Failed to delete role";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
