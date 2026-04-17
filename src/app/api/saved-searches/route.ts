import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";
import { v4 as uuid } from "uuid";
import { z, parseBody, nonEmptyString } from "@/lib/validation";

const SaveSearchSchema = z.object({
  name: nonEmptyString,
  filters: z.unknown(),
  isShared: z.boolean().optional(),
});

const DeleteSearchSchema = z.object({ searchId: nonEmptyString });

export async function GET() {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const db = getServiceClient();

    const { data } = await db
      .from("saved_searches")
      .select("*")
      .or(`userId.eq.${tenantUser.id},isShared.eq.true`)
      .eq("tenantId", tenantUser.tenantId)
      .order("name");

    return NextResponse.json(data || []);
  } catch (err) {
    console.error("Failed to fetch saved searches:", err);
    const message = err instanceof Error ? err.message : "Failed to fetch saved searches";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const parsed = await parseBody(request, SaveSearchSchema);
    if (!parsed.ok) return parsed.response;
    const { name, filters, isShared } = parsed.data;

    const db = getServiceClient();
    const now = new Date().toISOString();

    const { data, error } = await db.from("saved_searches").insert({
      id: uuid(),
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      name,
      filters,
      isShared: isShared || false,
      createdAt: now,
      updatedAt: now,
    }).select().single();

    if (error) throw error;
    return NextResponse.json(data);
  } catch (err) {
    console.error("Failed to save search:", err);
    const message = err instanceof Error ? err.message : "Failed to save search";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const parsed = await parseBody(request, DeleteSearchSchema);
    if (!parsed.ok) return parsed.response;
    const { searchId } = parsed.data;

    const db = getServiceClient();
    await db.from("saved_searches").delete().eq("id", searchId).eq("userId", tenantUser.id);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Failed to delete search:", err);
    const message = err instanceof Error ? err.message : "Failed to delete search";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
