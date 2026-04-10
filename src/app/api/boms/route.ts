import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { v4 as uuid } from "uuid";
import { z, parseBody, nonEmptyString } from "@/lib/validation";

const CreateBomSchema = z.object({
  name: nonEmptyString,
});

export async function GET() {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const db = getServiceClient();

    const { data } = await db
      .from("boms")
      .select("*")
      .eq("tenantId", tenantUser.tenantId)
      .order("createdAt", { ascending: false });
    return NextResponse.json(data || []);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch BOMs";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, CreateBomSchema);
    if (!parsed.ok) return parsed.response;
    const { name } = parsed.data;

    const db = getServiceClient();
    const now = new Date().toISOString();

    const { data: bom, error } = await db.from("boms").insert({
      id: uuid(),
      tenantId: tenantUser.tenantId,
      name,
      revision: "A",
      status: "DRAFT",
      createdById: tenantUser.id,
      createdAt: now,
      updatedAt: now,
    }).select().single();

    if (error) throw error;

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "bom.create", entityType: "bom", entityId: bom.id,
      details: { name },
    });

    return NextResponse.json(bom);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create BOM";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
