import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, permissionsExceedingActor, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { z, parseBody, nonEmptyString } from "@/lib/validation";

const UpdateUserSchema = z
  .object({
    isActive: z.boolean().optional(),
    roleId: nonEmptyString.optional(),
  })
  .refine((v) => v.isActive !== undefined || v.roleId !== undefined, {
    message: "At least one of isActive or roleId is required",
  });

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];

    if (!hasPermission(permissions, PERMISSIONS.ADMIN_USERS)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, UpdateUserSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const { userId } = await params;
    const db = getServiceClient();

    // Prevent self-deactivation
    if (userId === tenantUser.id && body.isActive === false) {
      return NextResponse.json({ error: "You cannot deactivate yourself" }, { status: 400 });
    }
    // Prevent self-role-change. An admin who fat-fingers themselves
    // into a Viewer role would lock themselves out of every admin
    // surface — including this endpoint — and need DB access to
    // recover. Force them to ask a peer admin instead.
    if (userId === tenantUser.id && body.roleId !== undefined) {
      return NextResponse.json({ error: "You cannot change your own role" }, { status: 400 });
    }

    const { data: targetUser } = await db
      .from("tenant_users")
      .select("id, fullName, tenantId, roleId")
      .eq("id", userId)
      .eq("tenantId", tenantUser.tenantId)
      .single();

    if (!targetUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // ── Role change ───────────────────────────────────────────────────
    let newRoleId: string | undefined;
    let newRoleName: string | undefined;
    if (body.roleId && body.roleId !== targetUser.roleId) {
      const { data: newRole } = await db
        .from("roles")
        .select("id, name, tenantId, permissions")
        .eq("id", body.roleId)
        .single();
      if (!newRole || newRole.tenantId !== tenantUser.tenantId) {
        return NextResponse.json({ error: "Invalid role" }, { status: 400 });
      }

      // Privilege ceiling — same as role authoring. You can't promote
      // someone to a role whose permissions exceed your own.
      const newRolePerms = Array.isArray(newRole.permissions) ? (newRole.permissions as string[]) : [];
      const excess = permissionsExceedingActor(newRolePerms, permissions);
      if (excess.length > 0) {
        return NextResponse.json(
          { error: `Cannot assign a role with permissions you don't hold: ${excess.join(", ")}` },
          { status: 403 }
        );
      }

      // Last-admin guard. If we're demoting the only user who holds
      // "*" on an active row, the tenant becomes unrecoverable. Count
      // active admins *other than* this target before allowing it.
      const targetIsAdmin = await isAdminRole(db, targetUser.roleId);
      const newIsAdmin = newRolePerms.includes("*");
      if (targetIsAdmin && !newIsAdmin) {
        const remainingAdmins = await countOtherActiveAdmins(db, tenantUser.tenantId, userId);
        if (remainingAdmins === 0) {
          return NextResponse.json(
            { error: "Cannot remove admin from the last active admin in this workspace" },
            { status: 400 }
          );
        }
      }

      newRoleId = newRole.id;
      newRoleName = newRole.name;
    }

    // ── Deactivation side effects ────────────────────────────────────
    // When deactivating, release all files the user has checked out so
    // they don't become permanent blockers for the rest of the team.
    let releasedCheckouts = 0;
    if (body.isActive === false) {
      const { data: checkedOut } = await db
        .from("files")
        .select("id, name")
        .eq("tenantId", tenantUser.tenantId)
        .eq("checkedOutById", userId)
        .eq("isCheckedOut", true);

      if (checkedOut && checkedOut.length > 0) {
        const now = new Date().toISOString();
        await db
          .from("files")
          .update({ isCheckedOut: false, checkedOutById: null, checkedOutAt: null, updatedAt: now })
          .eq("tenantId", tenantUser.tenantId)
          .eq("checkedOutById", userId)
          .eq("isCheckedOut", true);
        releasedCheckouts = checkedOut.length;

        for (const file of checkedOut) {
          await logAudit({
            tenantId: tenantUser.tenantId,
            userId: tenantUser.id,
            action: "file.undo_checkout",
            entityType: "file",
            entityId: file.id,
            details: { name: file.name, reason: "user_deactivated" },
          });
        }
      }

      // Last-admin guard also applies to deactivation — if the target
      // is the only active admin, deactivating them strands the tenant.
      if (await isAdminRole(db, targetUser.roleId)) {
        const remainingAdmins = await countOtherActiveAdmins(db, tenantUser.tenantId, userId);
        if (remainingAdmins === 0) {
          return NextResponse.json(
            { error: "Cannot deactivate the last active admin in this workspace" },
            { status: 400 }
          );
        }
      }
    }

    // ── Apply ─────────────────────────────────────────────────────────
    const updates: Record<string, unknown> = {};
    if (body.isActive !== undefined) updates.isActive = body.isActive;
    if (newRoleId !== undefined) updates.roleId = newRoleId;

    const { error } = await db
      .from("tenant_users")
      .update(updates)
      .eq("id", userId)
      .eq("tenantId", tenantUser.tenantId);

    if (error) throw error;

    if (body.isActive !== undefined) {
      await logAudit({
        tenantId: tenantUser.tenantId,
        userId: tenantUser.id,
        action: body.isActive ? "user.activate" : "user.deactivate",
        entityType: "user",
        entityId: userId,
        details: { targetUser: targetUser.fullName, releasedCheckouts },
      });
    }
    if (newRoleId !== undefined) {
      await logAudit({
        tenantId: tenantUser.tenantId,
        userId: tenantUser.id,
        action: "user.role_change",
        entityType: "user",
        entityId: userId,
        details: {
          targetUser: targetUser.fullName,
          fromRoleId: targetUser.roleId,
          toRoleId: newRoleId,
          toRoleName: newRoleName ?? null,
        },
      });
    }

    return NextResponse.json({
      success: true,
      isActive: body.isActive,
      roleId: newRoleId,
      releasedCheckouts,
    });
  } catch (err) {
    console.error("Failed to update user:", err);
    const message = err instanceof Error ? err.message : "Failed to update user";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

type Db = ReturnType<typeof getServiceClient>;

async function isAdminRole(db: Db, roleId: string): Promise<boolean> {
  const { data: role } = await db.from("roles").select("permissions").eq("id", roleId).single();
  const perms = Array.isArray(role?.permissions) ? (role.permissions as string[]) : [];
  return perms.includes("*");
}

/**
 * Count active users in the tenant who hold a "*" role, excluding the
 * given userId. Used for the last-admin guard on deactivation and role
 * change. The two-step query (find admin role IDs first, then count
 * users) keeps this readable and avoids a join PostgREST won't infer.
 */
async function countOtherActiveAdmins(db: Db, tenantId: string, excludeUserId: string): Promise<number> {
  const { data: roles } = await db
    .from("roles")
    .select("id, permissions")
    .eq("tenantId", tenantId);
  const adminRoleIds = (roles || [])
    .filter((r) => Array.isArray(r.permissions) && (r.permissions as string[]).includes("*"))
    .map((r) => r.id);
  if (adminRoleIds.length === 0) return 0;

  const { count } = await db
    .from("tenant_users")
    .select("*", { count: "exact", head: true })
    .eq("tenantId", tenantId)
    .eq("isActive", true)
    .neq("id", excludeUserId)
    .in("roleId", adminRoleIds);
  return count ?? 0;
}
