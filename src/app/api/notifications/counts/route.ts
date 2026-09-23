import { withTenant } from "@/lib/api-route";
import {
  categoryOfLink,
  isNotificationType,
  zeroByCategory,
  zeroByType,
} from "@/lib/notification-types";

// Unread-notification counts sliced two ways: by `type` (used to colour
// tabs on the /notifications page) and by "category" — a coarser
// grouping that maps onto sidebar nav items. Categories overlap with
// types but aren't identical: a BOM status change uses type=transition
// with link=/boms/... , and a file release uses type=transition with
// link=/vault?fileId=... — we need to split them for the sidebar.
//
// We return one object so the client makes a single request instead of
// fanning out. The query is a simple indexed scan on (userId, isRead).
//
// Both bucket lists come from notification-types.ts. They were spelled out
// here, so a type added there was counted toward `total` and nothing else.

export const GET = withTenant({}, async ({ db, tenantUser }) => {
  const { data, error } = await db
    .from("notifications")
    .select("type, link")
    .eq("userId", tenantUser.id)
    .eq("isRead", false);

  if (error) throw new Error(error.message);

  const byType = zeroByType();
  const byCategory = zeroByCategory();
  let total = 0;

  for (const row of (data || []) as Array<{ type: unknown; link: string | null }>) {
    total += 1;
    const type = row.type;
    if (isNotificationType(type)) byType[type] += 1;
    const category = categoryOfLink(row.link);
    if (category) byCategory[category] += 1;
  }

  return { total, byType, byCategory };
});
