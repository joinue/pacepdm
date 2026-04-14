import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";
import { z, parseBody } from "@/lib/validation";

const UpdateNotificationSchema = z.object({
  notificationId: z.string().optional(),
  markAllRead: z.boolean().optional(),
  /** Mark every unread notification referencing this entity id as read. */
  clearRef: z.string().optional(),
}).refine(
  (v) => v.notificationId || v.markAllRead || v.clearRef,
  { message: "Must specify notificationId, markAllRead, or clearRef" }
);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function GET(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const db = getServiceClient();

    // Cursor-based pagination: `before` is the ISO createdAt of the last row
    // the client already has — we return rows strictly older than that.
    const url = new URL(request.url);
    const before = url.searchParams.get("before");
    const limitParam = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(limitParam, MAX_LIMIT)
      : DEFAULT_LIMIT;

    let query = db
      .from("notifications")
      .select("*, actor:tenant_users!notifications_actorId_fkey(id, fullName)")
      .eq("tenantId", tenantUser.tenantId)
      .eq("userId", tenantUser.id)
      .order("createdAt", { ascending: false })
      .limit(limit + 1); // fetch one extra to detect hasMore

    if (before) {
      query = query.lt("createdAt", before);
    }

    const { data, error } = await query;
    if (error) throw error;

    const rows = data || [];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? items[items.length - 1].createdAt : null;

    return NextResponse.json({ items, nextCursor, hasMore });
  } catch (err) {
    console.error("[notifications.GET]", err);
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
    const { notificationId, markAllRead, clearRef } = parsed.data;

    const db = getServiceClient();

    if (markAllRead) {
      const { error } = await db.from("notifications")
        .update({ isRead: true })
        .eq("tenantId", tenantUser.tenantId)
        .eq("userId", tenantUser.id)
        .eq("isRead", false);
      if (error) throw error;
    } else if (clearRef) {
      // Auto-clear on entity navigation: when a user opens a BOM/ECO/file,
      // any unread notifications that reference it should stop nagging.
      const { error } = await db.from("notifications")
        .update({ isRead: true })
        .eq("tenantId", tenantUser.tenantId)
        .eq("userId", tenantUser.id)
        .eq("refId", clearRef)
        .eq("isRead", false);
      if (error) throw error;
    } else if (notificationId) {
      const { error } = await db.from("notifications")
        .update({ isRead: true })
        .eq("id", notificationId)
        .eq("tenantId", tenantUser.tenantId)
        .eq("userId", tenantUser.id);
      if (error) throw error;
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[notifications.PUT]", err);
    const message = err instanceof Error ? err.message : "Failed to update notifications";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    const clearRead = url.searchParams.get("clearRead") === "true";

    if (!id && !clearRead) {
      return NextResponse.json(
        { error: "Must specify id or clearRead=true" },
        { status: 400 }
      );
    }

    const db = getServiceClient();

    if (clearRead) {
      // Bulk clear: only removes notifications the user has already read,
      // so unread items can't be wiped by accident.
      const { error } = await db.from("notifications")
        .delete()
        .eq("tenantId", tenantUser.tenantId)
        .eq("userId", tenantUser.id)
        .eq("isRead", true);
      if (error) throw error;
    } else if (id) {
      const { error } = await db.from("notifications")
        .delete()
        .eq("id", id)
        .eq("tenantId", tenantUser.tenantId)
        .eq("userId", tenantUser.id);
      if (error) throw error;
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[notifications.DELETE]", err);
    const message = err instanceof Error ? err.message : "Failed to delete notifications";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
