import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { v4 as uuid } from "uuid";
import { logAudit } from "@/lib/audit";

export async function GET() {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const db = getServiceClient();

    const { data: roles } = await db
      .from("roles")
      .select("*")
      .eq("tenantId", tenantUser.tenantId)
      .order("isSystem", { ascending: false })
      .order("name");

    return NextResponse.json(roles || []);
  } catch {
    return NextResponse.json({ error: "Failed to fetch roles" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.ADMIN_ROLES)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { name, description, permissions: rolePerms } = await request.json();
    if (!name?.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const db = getServiceClient();
    const now = new Date().toISOString();

    const { data: role, error } = await db.from("roles").insert({
      id: uuid(),
      tenantId: tenantUser.tenantId,
      name: name.trim(),
      description: description || null,
      permissions: rolePerms || [],
      isSystem: false,
      canEdit: true,
      createdAt: now,
      updatedAt: now,
    }).select().single();

    if (error) {
      if (error.code === "23505") return NextResponse.json({ error: "Role name already exists" }, { status: 409 });
      throw error;
    }

    await logAudit({ tenantId: tenantUser.tenantId, userId: tenantUser.id, action: "role.create", entityType: "role", entityId: role.id, details: { name: name.trim() } });

    return NextResponse.json(role);
  } catch {
    return NextResponse.json({ error: "Failed to create role" }, { status: 500 });
  }
}
