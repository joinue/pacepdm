import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const q = request.nextUrl.searchParams.get("q") || "";
    if (q.length < 1) return NextResponse.json([]);

    const db = getServiceClient();
    const { data: users } = await db
      .from("tenant_users")
      .select("id, fullName, email")
      .eq("tenantId", tenantUser.tenantId)
      .eq("isActive", true)
      .ilike("fullName", `%${q}%`)
      .neq("id", tenantUser.id)
      .limit(10);

    return NextResponse.json(users || []);
  } catch {
    return NextResponse.json(
      { error: "Failed to search users" },
      { status: 500 }
    );
  }
}
