import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { v4 as uuid } from "uuid";
import { z, parseBody, nonEmptyString } from "@/lib/validation";
import { getFolderAccessScope, canAdminFolder, canViewFolder } from "@/lib/folder-access";

// CRUD for per-folder ACL rows. Gated two ways:
//   - Tenant admins (FOLDER_MANAGE_ACCESS or "*") can manage any folder
//   - Users holding ADMIN level on this folder (via a row on it or an
//     ancestor) can manage its rows, even without the tenant permission
// "Can't see it" returns 404 to avoid leaking folder existence.

const CreateRowSchema = z.object({
  principalType: z.enum(["USER", "ROLE"]),
  principalId: nonEmptyString,
  level: z.enum(["VIEW", "EDIT", "ADMIN"]),
  effect: z.enum(["ALLOW", "DENY"]).optional(),
  inherited: z.boolean().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

async function authorize(
  folderId: string
): Promise<
  | { ok: true; tenantUser: Awaited<ReturnType<typeof getApiTenantUser>>; db: ReturnType<typeof getServiceClient> }
  | { ok: false; response: NextResponse }
> {
  const tenantUser = await getApiTenantUser();
  if (!tenantUser) return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  const db = getServiceClient();
  const { data: folder } = await db
    .from("folders")
    .select("id, tenantId")
    .eq("id", folderId)
    .single();
  if (!folder || folder.tenantId !== tenantUser.tenantId) {
    return { ok: false, response: NextResponse.json({ error: "Folder not found" }, { status: 404 }) };
  }

  const scope = await getFolderAccessScope(tenantUser);
  if (!canViewFolder(scope, folderId)) {
    return { ok: false, response: NextResponse.json({ error: "Folder not found" }, { status: 404 }) };
  }

  const perms = Array.isArray(tenantUser.role.permissions) ? (tenantUser.role.permissions as string[]) : [];
  const isTenantManager = hasPermission(perms, PERMISSIONS.FOLDER_MANAGE_ACCESS);
  const isFolderAdmin = canAdminFolder(scope, folderId);
  if (!isTenantManager && !isFolderAdmin) {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  return { ok: true, tenantUser, db };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ folderId: string }> }
) {
  try {
    const { folderId } = await params;
    const auth = await authorize(folderId);
    if (!auth.ok) return auth.response;

    // Return only rows attached directly to this folder. Inherited rows
    // from ancestors are visible via the UI's "effective access" view,
    // which the client computes by walking up the tree.
    const { data } = await auth.db
      .from("folder_access")
      .select(`
        *,
        grantedBy:tenant_users!folder_access_grantedById_fkey(id, fullName, email)
      `)
      .eq("folderId", folderId)
      .eq("tenantId", auth.tenantUser!.tenantId)
      .order("grantedAt", { ascending: false });

    return NextResponse.json(data || []);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load folder access";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ folderId: string }> }
) {
  try {
    const { folderId } = await params;
    const auth = await authorize(folderId);
    if (!auth.ok) return auth.response;

    const parsed = await parseBody(request, CreateRowSchema);
    if (!parsed.ok) return parsed.response;
    const { principalType, principalId, level, effect, inherited, expiresAt, note } = parsed.data;

    // Verify the principal actually exists within this tenant. Prevents
    // typos, cross-tenant references, and stale role/user IDs from ending
    // up in the ACL table.
    if (principalType === "USER") {
      const { data: u } = await auth.db
        .from("tenant_users")
        .select("id, tenantId")
        .eq("id", principalId)
        .single();
      if (!u || u.tenantId !== auth.tenantUser!.tenantId) {
        return NextResponse.json({ error: "User not found in this tenant" }, { status: 400 });
      }
    } else {
      const { data: r } = await auth.db
        .from("roles")
        .select("id, tenantId")
        .eq("id", principalId)
        .single();
      if (!r || r.tenantId !== auth.tenantUser!.tenantId) {
        return NextResponse.json({ error: "Role not found in this tenant" }, { status: 400 });
      }
    }

    const { data: row, error } = await auth.db
      .from("folder_access")
      .insert({
        id: uuid(),
        tenantId: auth.tenantUser!.tenantId,
        folderId,
        principalType,
        principalId,
        level,
        effect: effect ?? "ALLOW",
        inherited: inherited ?? true,
        grantedById: auth.tenantUser!.id,
        grantedAt: new Date().toISOString(),
        expiresAt: expiresAt ?? null,
        note: note ?? null,
      })
      .select()
      .single();

    if (error) throw error;

    await logAudit({
      tenantId: auth.tenantUser!.tenantId,
      userId: auth.tenantUser!.id,
      action: "folder.access.grant",
      entityType: "folder",
      entityId: folderId,
      details: { principalType, principalId, level, effect: effect ?? "ALLOW" },
    });

    return NextResponse.json(row);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to grant folder access";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ folderId: string }> }
) {
  try {
    const { folderId } = await params;
    const auth = await authorize(folderId);
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const rowId = searchParams.get("rowId");
    if (!rowId) return NextResponse.json({ error: "rowId is required" }, { status: 400 });

    // Row must belong to this folder AND this tenant — the tenantId check
    // is a defense-in-depth barrier in case the folder check above is
    // ever weakened.
    const { data: existing } = await auth.db
      .from("folder_access")
      .select("id, tenantId, folderId, principalType, principalId, level")
      .eq("id", rowId)
      .single();
    if (!existing || existing.tenantId !== auth.tenantUser!.tenantId || existing.folderId !== folderId) {
      return NextResponse.json({ error: "Access row not found" }, { status: 404 });
    }

    const { error } = await auth.db.from("folder_access").delete().eq("id", rowId);
    if (error) throw error;

    await logAudit({
      tenantId: auth.tenantUser!.tenantId,
      userId: auth.tenantUser!.id,
      action: "folder.access.revoke",
      entityType: "folder",
      entityId: folderId,
      details: {
        principalType: existing.principalType,
        principalId: existing.principalId,
        level: existing.level,
      },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to revoke folder access";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
