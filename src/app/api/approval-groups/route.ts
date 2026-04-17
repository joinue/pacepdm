import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { v4 as uuid } from "uuid";
import { logAudit } from "@/lib/audit";
import { z, parseBody, nonEmptyString, optionalString } from "@/lib/validation";

const CreateGroupSchema = z.object({
  name: nonEmptyString,
  description: optionalString,
});

export async function GET(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const db = getServiceClient();

    // The workflow editor's group picker passes activeOnly=true so
    // archived groups can't be wired into new workflow steps. The
    // approval-groups admin page omits the flag to show everything.
    const activeOnly = request.nextUrl.searchParams.get("activeOnly") === "true";

    let query = db
      .from("approval_groups")
      .select("*")
      .eq("tenantId", tenantUser.tenantId)
      .order("name");
    if (activeOnly) query = query.eq("isActive", true);

    const { data: groups } = await query;

    // Enrich with members + usage count (number of workflow steps that
    // reference the group). The admin UI uses usageCount to disambiguate
    // archive (referenced) from delete (pristine) before the user clicks.
    const enriched = await Promise.all(
      (groups || []).map(async (group) => {
        const [{ data: members }, { count: usageCount }] = await Promise.all([
          db.from("approval_group_members")
            .select("*, user:tenant_users!approval_group_members_userId_fkey(id, fullName, email)")
            .eq("groupId", group.id),
          db.from("approval_workflow_steps")
            .select("*", { count: "exact", head: true })
            .eq("groupId", group.id),
        ]);
        return { ...group, members: members || [], usageCount: usageCount ?? 0 };
      })
    );

    return NextResponse.json(enriched);
  } catch (err) {
    console.error("Failed to fetch groups:", err);
    const message = err instanceof Error ? err.message : "Failed to fetch groups";
    return NextResponse.json({ error: message }, { status: 500 });
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

    const parsed = await parseBody(request, CreateGroupSchema);
    if (!parsed.ok) return parsed.response;
    const { name, description } = parsed.data;

    const db = getServiceClient();
    const now = new Date().toISOString();

    const { data: group, error } = await db
      .from("approval_groups")
      .insert({
        id: uuid(),
        tenantId: tenantUser.tenantId,
        name,
        description: description ?? null,
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

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "approval_group.create", entityType: "approval_group",
      entityId: group.id, details: { name },
    });

    return NextResponse.json({ ...group, members: [] });
  } catch (err) {
    console.error("Failed to create group:", err);
    const message = err instanceof Error ? err.message : "Failed to create group";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
