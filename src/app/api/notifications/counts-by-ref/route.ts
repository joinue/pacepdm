import { withTenant } from "@/lib/api-route";
import { z } from "@/lib/validation";

/**
 * Per-refId unread count for the current user, optionally filtered by
 * link prefix. Used by list pages (BOMs, ECOs, etc.) to show a badge on
 * the individual row that has new activity, instead of only the
 * category-level badge in the sidebar.
 *
 * Example: GET /api/notifications/counts-by-ref?prefix=/boms/
 * Returns: { counts: { "<bomId>": 2, "<bomId2>": 1 } }
 */

const QuerySchema = z.object({ prefix: z.string().optional() });

export const GET = withTenant({ query: QuerySchema }, async ({ db, tenantUser, query }) => {
  let q = db
    .from("notifications")
    .select("refId")
    .eq("userId", tenantUser.id)
    .eq("isRead", false)
    .not("refId", "is", null);

  if (query.prefix) q = q.like("link", `${query.prefix}%`);

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const counts: Record<string, number> = {};
  for (const row of data || []) {
    const id = row.refId as string | null;
    if (!id) continue;
    counts[id] = (counts[id] || 0) + 1;
  }

  return { counts };
});
