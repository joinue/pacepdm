import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";
import { z, parseBody } from "@/lib/validation";

const UpdateNotificationSchema = z.object({
  notificationId: z.string().optional(),
  markAllRead: z.boolean().optional(),
}).refine(
  (v) => v.notificationId || v.markAllRead,
  { message: "Must specify notificationId or markAllRead" }
);

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
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch notifications";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const parsed = await parseBody(request, UpdateNotificationSchema);
    if (!parsed.ok) return parsed.response;
    const { notificationId, markAllRead } = parsed.data;

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
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update notifications";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
