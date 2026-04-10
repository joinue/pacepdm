import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const q = request.nextUrl.searchParams.get("q") || "";

    const db = getServiceClient();
    // Empty q returns the first batch of active tenant members (used by the
    // folder-access picker to populate a dropdown). Non-empty q narrows by
    // name prefix like before.
    let query = db
      .from("tenant_users")
      .select("id, fullName, email")
      .eq("tenantId", tenantUser.tenantId)
      .eq("isActive", true)
      .neq("id", tenantUser.id)
      .limit(q.length > 0 ? 10 : 50);

    if (q.length > 0) {
      query = query.ilike("fullName", `%${q}%`);
    }

    const { data: users } = await query;

    return NextResponse.json(users || []);
  } catch {
    return NextResponse.json(
      { error: "Failed to search users" },
      { status: 500 }
    );
  }
}
