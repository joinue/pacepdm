import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";
import { v4 as uuid } from "uuid";

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
  } catch {
    return NextResponse.json({ error: "Failed to fetch saved searches" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { name, filters, isShared } = await request.json();

    if (!name?.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const db = getServiceClient();
    const now = new Date().toISOString();

    const { data, error } = await db.from("saved_searches").insert({
      id: uuid(),
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      name: name.trim(),
      filters,
      isShared: isShared || false,
      createdAt: now,
      updatedAt: now,
    }).select().single();

    if (error) throw error;
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Failed to save search" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { searchId } = await request.json();
    const db = getServiceClient();

    await db.from("saved_searches").delete().eq("id", searchId).eq("userId", tenantUser.id);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete search" }, { status: 500 });
  }
}
