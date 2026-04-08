import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getCurrentTenantUser } from "@/lib/auth";

// Get pending approvals for the current user
export async function GET() {
  try {
    const tenantUser = await getCurrentTenantUser();
    const db = getServiceClient();

    // Find all groups this user belongs to
    const { data: memberships } = await db
      .from("approval_group_members")
      .select("groupId")
      .eq("userId", tenantUser.id);

    const groupIds = (memberships || []).map((m) => m.groupId);

    if (groupIds.length === 0) {
      return NextResponse.json([]);
    }

    // Find pending decisions for those groups
    const { data: decisions } = await db
      .from("approval_decisions")
      .select(`
        *,
        group:approval_groups!approval_decisions_groupId_fkey(name),
        request:approval_requests!approval_decisions_requestId_fkey(
          id, type, entityType, entityId, title, description, status, createdAt,
          requestedBy:tenant_users!approval_requests_requestedById_fkey(fullName, email)
        )
      `)
      .in("groupId", groupIds)
      .eq("status", "PENDING")
      .order("createdAt", { ascending: false });

    // Filter to only show decisions where the parent request is still pending
    const pending = (decisions || []).filter(
      (d) => d.request?.status === "PENDING"
    );

    return NextResponse.json(pending);
  } catch {
    return NextResponse.json({ error: "Failed to fetch approvals" }, { status: 500 });
  }
}
