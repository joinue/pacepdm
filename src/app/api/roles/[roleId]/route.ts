import { withTenant, badRequest, conflict, forbidden, notFound } from "@/lib/api-route";
import { PERMISSIONS, permissionsExceedingActor } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { z, optionalString, uuid } from "@/lib/validation";

const UpdateRoleSchema = z.object({
  name: z.string().trim().min(1).optional(),
  description: optionalString,
  permissions: z.array(z.string()).optional(),
});

const ParamsSchema = z.object({ roleId: uuid });

export const PUT = withTenant(
  {
    permission: PERMISSIONS.ADMIN_ROLES,
    body: UpdateRoleSchema,
    params: ParamsSchema,
  },
  async ({ db, tenantUser, permissions, params, body }) => {
    const { data: role } = await db.from("roles").select("*").eq("id", params.roleId).maybeSingle();
    if (!role) throw notFound();

    // System roles (Admin / Engineer / Viewer) are part of the
    // application's contract — neutering Admin's permissions would
    // brick the workspace. DELETE already blocks them; PUT needs the
    // same fence so an ADMIN_ROLES holder can't strip "*" from Admin.
    if (role.isSystem) throw badRequest("Cannot edit system roles");

    // Privilege ceiling — same reason as POST in /api/roles. You can
    // only assign permissions you yourself hold.
    if (body.permissions !== undefined) {
      const excess = permissionsExceedingActor(body.permissions, permissions);
      if (excess.length > 0) {
        throw forbidden(`Cannot grant permissions you don't hold: ${excess.join(", ")}`);
      }
    }

    // Wrapped route, so a genuine write failure throws and the wrapper
    // surfaces the message. What must not happen is the audit row below
    // recording a permission change that did not take effect.
    const { error } = await db
      .from("roles")
      .update({
        name: body.name ?? role.name,
        description: body.description ?? role.description,
        permissions: body.permissions ?? role.permissions,
        updatedAt: new Date().toISOString(),
      })
      .eq("id", params.roleId);
    if (error) throw new Error(error.message);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "role.update",
      entityType: "role",
      entityId: params.roleId,
      details: { name: body.name ?? role.name },
    });

    return { success: true };
  }
);

export const DELETE = withTenant(
  { permission: PERMISSIONS.ADMIN_ROLES, params: ParamsSchema },
  async ({ db, tenantUser, params }) => {
    const { data: role } = await db.from("roles").select("*").eq("id", params.roleId).maybeSingle();
    if (!role) throw notFound();
    if (role.isSystem) throw badRequest("Cannot delete system roles");

    // Check if anyone is using this role
    const { count } = await db
      .from("tenant_users")
      .select("*", { count: "exact", head: true })
      .eq("roleId", params.roleId);
    if (count && count > 0) {
      throw conflict("Cannot delete a role that has users assigned to it");
    }

    // The count above is the real guard, but `tenant_users_roleId_fkey` is
    // ON DELETE RESTRICT and a user could be assigned in the gap between the
    // two statements. Without checking the error, that race would report
    // success and audit-log a deletion of a role that still exists.
    const { error: deleteError } = await db.from("roles").delete().eq("id", params.roleId);
    if (deleteError) {
      throw conflict(`Could not delete role: ${deleteError.message}`);
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "role.delete",
      entityType: "role",
      entityId: params.roleId,
      details: { name: role.name },
    });

    return { success: true };
  }
);
