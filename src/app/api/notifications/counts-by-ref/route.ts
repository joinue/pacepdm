import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";

/**
 * Per-refId unread count for the current user, optionally filtered by
 * link prefix. Used by list pages (BOMs, ECOs, etc.) to show a badge on
 * the individual row that has new activity, instead of only the
 * category-level badge in the sidebar.
 *
 * Example: GET /api/notifications/counts-by-ref?prefix=/boms/
 * Returns: { counts: { "<bomId>": 2, "<bomId2>": 1 } }
 */
export async function GET(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const url = new URL(request.url);
    const prefix = url.searchParams.get("prefix") || undefined;

    const db = getServiceClient();
    let q = db
      .from("notifications")
      .select("refId")
      .eq("tenantId", tenantUser.tenantId)
      .eq("userId", tenantUser.id)
      .eq("isRead", false)
      .not("refId", "is", null);

    if (prefix) q = q.like("link", `${prefix}%`);

    const { data, error } = await q;
    if (error) throw error;

    const counts: Record<string, number> = {};
    for (const row of data || []) {
      const id = row.refId as string | null;
      if (!id) continue;
      counts[id] = (counts[id] || 0) + 1;
    }

    return NextResponse.json({ counts });
  } catch (err) {
    console.error("[notifications.counts-by-ref]", err);
    const message = err instanceof Error ? err.message : "Failed to fetch counts";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
