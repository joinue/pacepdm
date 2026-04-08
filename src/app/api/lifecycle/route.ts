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

    const { data: lifecycles } = await db
      .from("lifecycles")
      .select("*")
      .eq("tenantId", tenantUser.tenantId)
      .order("name");

    const enriched = await Promise.all(
      (lifecycles || []).map(async (lc) => {
        const [{ data: states }, { data: transitions }] = await Promise.all([
          db
            .from("lifecycle_states")
            .select("*")
            .eq("lifecycleId", lc.id)
            .order("sortOrder"),
          db
            .from("lifecycle_transitions")
            .select(
              "*, fromState:lifecycle_states!lifecycle_transitions_fromStateId_fkey(id, name), toState:lifecycle_states!lifecycle_transitions_toStateId_fkey(id, name)"
            )
            .eq("lifecycleId", lc.id),
        ]);
        return { ...lc, states: states || [], transitions: transitions || [] };
      })
    );

    return NextResponse.json(enriched);
  } catch {
    return NextResponse.json({ error: "Failed to fetch lifecycles" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.ADMIN_LIFECYCLE)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { name, isDefault } = await request.json();
    if (!name?.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const db = getServiceClient();
    const now = new Date().toISOString();

    // If marking as default, unset other defaults first
    if (isDefault) {
      await db
        .from("lifecycles")
        .update({ isDefault: false, updatedAt: now })
        .eq("tenantId", tenantUser.tenantId)
        .eq("isDefault", true);
    }

    const { data: lifecycle, error } = await db
      .from("lifecycles")
      .insert({
        id: uuid(),
        tenantId: tenantUser.tenantId,
        name: name.trim(),
        isDefault: !!isDefault,
        createdAt: now,
        updatedAt: now,
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505")
        return NextResponse.json({ error: "Lifecycle name already exists" }, { status: 409 });
      throw error;
    }

    await logAudit({ tenantId: tenantUser.tenantId, userId: tenantUser.id, action: "lifecycle.create", entityType: "lifecycle", entityId: lifecycle.id, details: { name: name.trim(), isDefault: !!isDefault } });

    return NextResponse.json(lifecycle);
  } catch {
    return NextResponse.json({ error: "Failed to create lifecycle" }, { status: 500 });
  }
}
