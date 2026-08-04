import { withTenant, conflict, forbidden } from "@/lib/api-route";
import { PERMISSIONS, permissionsExceedingActor } from "@/lib/permissions";
import { v4 as uuid } from "uuid";
import { logAudit } from "@/lib/audit";
import { z, nonEmptyString, optionalString } from "@/lib/validation";

const CreateRoleSchema = z.object({
  name: nonEmptyString,
  description: optionalString,
  permissions: z.array(z.string()).optional(),
});

export const GET = withTenant({}, async ({ db }) => {
  const { data: roles } = await db
    .from("roles")
    .select("*")
    .order("isSystem", { ascending: false })
    .order("name");

  return roles || [];
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
