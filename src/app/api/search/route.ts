import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getCurrentTenantUser } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    const tenantUser = await getCurrentTenantUser();
    const { searchParams } = new URL(request.url);
    const query = searchParams.get("q") || "";
    const category = searchParams.get("category") || "";
    const state = searchParams.get("state") || "";

    if (!query && !category && !state) {
      return NextResponse.json([]);
    }

    const db = getServiceClient();

    let dbQuery = db
      .from("files")
      .select(`
        *,
        folder:folders!files_folderId_fkey(path),
        checkedOutBy:tenant_users!files_checkedOutById_fkey(fullName)
      `)
      .eq("tenantId", tenantUser.tenantId)
      .order("updatedAt", { ascending: false })
      .limit(100);

    if (query) {
      dbQuery = dbQuery.or(`name.ilike.%${query}%,partNumber.ilike.%${query}%,description.ilike.%${query}%`);
    }
    if (category) {
      dbQuery = dbQuery.eq("category", category);
    }
    if (state) {
      dbQuery = dbQuery.eq("lifecycleState", state);
    }

    const { data: files } = await dbQuery;

    return NextResponse.json(files || []);
  } catch {
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
