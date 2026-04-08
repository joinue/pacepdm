import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";

export async function GET() {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const db = getServiceClient();

    const { data: notifications } = await db
      .from("notifications")
      .select("*")
      .eq("userId", tenantUser.id)
      .order("createdAt", { ascending: false })
      .limit(50);

    return NextResponse.json(notifications || []);
  } catch {
    return NextResponse.json({ error: "Failed to fetch notifications" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { notificationId, markAllRead } = await request.json();
    const db = getServiceClient();

    if (markAllRead) {
      await db.from("notifications")
        .update({ isRead: true })
        .eq("userId", tenantUser.id)
        .eq("isRead", false);
    } else if (notificationId) {
      await db.from("notifications")
        .update({ isRead: true })
        .eq("id", notificationId)
        .eq("userId", tenantUser.id);
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to update notifications" }, { status: 500 });
  }
}
