import { withTenant, conflict, forbidden } from "@/lib/api-route";
import { PERMISSIONS, permissionsExceedingActor, hasPermission } from "@/lib/permissions";
import { v4 as uuid } from "uuid";
import { logAudit } from "@/lib/audit";
import { z, nonEmptyString, optionalString } from "@/lib/validation";

const CreateRoleSchema = z.object({
  name: nonEmptyString,
  description: optionalString,
  permissions: z.array(z.string()).optional(),
});

/**
 * The role list, at one of two levels of detail.
 *
 * This route cannot simply require ADMIN_ROLES: the folder access dialog
 * offers "grant this role access to this folder" and needs role names for
 * anyone holding FOLDER_MANAGE_ACCESS, and the SSO screen maps an IdP
 * attribute onto a default role. Both need identity, neither needs the
 * permission set.
 *
 * So the identifying columns are readable by any tenant user, and the parts
 * that describe what a role can *do* — its permission array and how many
 * people hold it — are limited to the two roles that administer them. A
 * Viewer enumerating exactly which permissions each role carries is a map of
 * the tenant's authorisation model, and nothing in the product needs it.
 */
export const GET = withTenant({}, async ({ db, permissions }) => {
  const { data: roles } = await db
    .from("roles")
    .select("*")
    .order("isSystem", { ascending: false })
    .order("name");

  if (!roles) return [];

  // ADMIN_USERS is included alongside ADMIN_ROLES because assigning someone
  // a role without being able to see what it grants is how over-privileging
  // happens.
  const seesDetail =
    hasPermission(permissions, PERMISSIONS.ADMIN_ROLES) ||
    hasPermission(permissions, PERMISSIONS.ADMIN_USERS);

  if (!seesDetail) {
    return roles.map((role: { id: string; name: string; description: string | null }) => ({
      id: role.id,
      name: role.name,
      description: role.description,
    }));
  }

  // Assigned-user counts, so the admin screen can show which roles are in
  // use and disable delete up front rather than surfacing the 409 from
  // DELETE only after someone has tried.
  //
  // Deliberately NOT filtered to active users: DELETE's guard counts every
  // tenant_users row holding the role, so a role whose only holder is
  // deactivated still cannot be deleted. Counting only active users here
  // would show "0 users" beside a delete button that then 409s.
  //
  // One pass over the tenant's users rather than a count query per role — a
  // tenant has tens of users and a handful of roles, so the round trips
  // would cost more than the rows do.
  const { data: assignments } = await db.from("tenant_users").select("roleId");

  const counts = new Map<string, number>();
  for (const row of assignments ?? []) {
    const roleId = (row as { roleId: string | null }).roleId;
    if (roleId) counts.set(roleId, (counts.get(roleId) ?? 0) + 1);
  }

  return roles.map((role: { id: string }) => ({ ...role, userCount: counts.get(role.id) ?? 0 }));
});

export const POST = withTenant(
  { permission: PERMISSIONS.ADMIN_ROLES, body: CreateRoleSchema },
  async ({ db, tenantUser, permissions, body }) => {
    // Privilege ceiling — you can't grant a permission you don't already
    // hold. Without this, anyone with ADMIN_ROLES could mint a "*" role
    // and (via /api/users/[userId] role reassignment) escalate to full
    // admin without ADMIN_USERS or ADMIN_SETTINGS.
    const excess = permissionsExceedingActor(body.permissions || [], permissions);
    if (excess.length > 0) {
      throw forbidden(`Cannot grant permissions you don't hold: ${excess.join(", ")}`);
    }

    const now = new Date().toISOString();

    const { data: role, error } = await db
      .from("roles")
      .insert({
        id: uuid(),
        name: body.name,
        description: body.description ?? null,
        permissions: body.permissions || [],
        isSystem: false,
        canEdit: true,
        createdAt: now,
        updatedAt: now,
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") throw conflict("Role name already exists");
      throw new Error(error.message);
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "role.create",
      entityType: "role",
      entityId: role.id,
      details: { name: body.name },
    });

    return role;
  }
);
