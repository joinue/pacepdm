import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { notify } from "@/lib/notifications";
import { v4 as uuid } from "uuid";

export async function GET() {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const db = getServiceClient();

    const { data: ecos } = await db
      .from("ecos")
      .select("*")
      .eq("tenantId", tenantUser.tenantId)
      .order("createdAt", { ascending: false });

    return NextResponse.json(ecos || []);
  } catch {
    return NextResponse.json({ error: "Failed to fetch ECOs" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];

    if (!hasPermission(permissions, PERMISSIONS.ECO_CREATE)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { title, description, priority, reason, changeType } = await request.json();

    if (!title?.trim()) {
      return NextResponse.json({ error: "Title is required" }, { status: 400 });
    }

    const db = getServiceClient();
    const now = new Date().toISOString();

    // Generate ECO number
    const { count } = await db
      .from("ecos")
      .select("*", { count: "exact", head: true })
      .eq("tenantId", tenantUser.tenantId);

    const ecoNumber = `ECO-${String((count || 0) + 1).padStart(4, "0")}`;

    const { data: eco, error } = await db
      .from("ecos")
      .insert({
        id: uuid(),
        tenantId: tenantUser.tenantId,
        ecoNumber,
        title: title.trim(),
        description: description || null,
        status: "DRAFT",
        priority: priority || "MEDIUM",
        reason: reason || null,
        changeType: changeType || null,
        costImpact: null,
        disposition: null,
        effectivity: null,
        createdById: tenantUser.id,
        createdAt: now,
        updatedAt: now,
      })
      .select()
      .single();

    if (error) throw error;

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "eco.create",
      entityType: "eco",
      entityId: eco.id,
      details: { ecoNumber, title: title.trim() },
    });

    // Notify admins about new ECO
    const { data: admins } = await db
      .from("tenant_users")
      .select("id, role:roles!inner(permissions)")
      .eq("tenantId", tenantUser.tenantId)
      .neq("id", tenantUser.id);

    const adminIds = (admins || [])
      .filter((u) => {
        const role = u.role as unknown as { permissions: string[] };
        const perms = role?.permissions || [];
        return perms.includes("*") || perms.includes("eco.approve");
      })
      .map((u) => u.id);

    if (adminIds.length > 0) {
      await notify({
        tenantId: tenantUser.tenantId,
        userIds: adminIds,
        title: "New ECO created",
        message: `${tenantUser.fullName} created ${ecoNumber}: ${title.trim()}`,
        type: "eco",
        link: `/ecos`,
      }).catch(() => {});
    }

    return NextResponse.json(eco);
  } catch {
    return NextResponse.json({ error: "Failed to create ECO" }, { status: 500 });
  }
}
