import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";

// Unread-notification counts sliced two ways: by `type` (used to colour
// tabs on the /notifications page) and by "category" — a coarser
// grouping that maps onto sidebar nav items. Categories overlap with
// types but aren't identical: a BOM status change uses type=transition
// with link=/boms/... , and a file release uses type=transition with
// link=/vault?file=... — we need to split them for the sidebar.
//
// We return one object so the client makes a single request instead of
// fanning out. The query is a simple indexed scan on (userId, isRead).

export async function GET() {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const db = getServiceClient();
    const { data, error } = await db
      .from("notifications")
      .select("type, link")
      .eq("tenantId", tenantUser.tenantId)
      .eq("userId", tenantUser.id)
      .eq("isRead", false);

    if (error) throw error;

    const byType: Record<string, number> = {
      approval: 0, transition: 0, checkout: 0, eco: 0, system: 0,
    };
    const byCategory = { vault: 0, boms: 0, ecos: 0, parts: 0, vendors: 0 };
    let total = 0;

    for (const row of data || []) {
      total += 1;
      if (row.type in byType) byType[row.type] += 1;
      const link: string | null = row.link;
      if (link) {
        if (link.startsWith("/vault")) byCategory.vault += 1;
        else if (link.startsWith("/boms")) byCategory.boms += 1;
        else if (link.startsWith("/ecos")) byCategory.ecos += 1;
        else if (link.startsWith("/parts")) byCategory.parts += 1;
        else if (link.startsWith("/vendors")) byCategory.vendors += 1;
      }
    }

    return NextResponse.json({ total, byType, byCategory });
  } catch (err) {
    console.error("[notifications.counts.GET]", err);
    const message = err instanceof Error ? err.message : "Failed to fetch notification counts";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
