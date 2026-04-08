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

    const { data: groups } = await db
      .from("approval_groups")
      .select("*")
      .eq("tenantId", tenantUser.tenantId)
      .order("name");

    // Get members for each group
    const enriched = await Promise.all(
      (groups || []).map(async (group) => {
        const { data: members } = await db
          .from("approval_group_members")
          .select("*, user:tenant_users!approval_group_members_userId_fkey(id, fullName, email)")
          .eq("groupId", group.id);
        return { ...group, members: members || [] };
      })
    );

    return NextResponse.json(enriched);
  } catch {
    return NextResponse.json({ error: "Failed to fetch groups" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.ADMIN_SETTINGS)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { name, description } = await request.json();
    if (!name?.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const db = getServiceClient();
    const now = new Date().toISOString();

    const { data: group, error } = await db
      .from("approval_groups")
      .insert({
        id: uuid(),
        tenantId: tenantUser.tenantId,
        name: name.trim(),
        description: description || null,
        createdAt: now,
        updatedAt: now,
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: "A group with this name already exists" }, { status: 409 });
      }
      throw error;
    }

    await logAudit({ tenantId: tenantUser.tenantId, userId: tenantUser.id, action: "approval_group.create", entityType: "approval_group", entityId: group.id, details: { name: name.trim() } });

    return NextResponse.json({ ...group, members: [] });
  } catch {
    return NextResponse.json({ error: "Failed to create group" }, { status: 500 });
  }
}
