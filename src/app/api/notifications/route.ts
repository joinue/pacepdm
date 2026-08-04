import { withTenant, badRequest } from "@/lib/api-route";
import { z } from "@/lib/validation";

const UpdateNotificationSchema = z
  .object({
    notificationId: z.string().optional(),
    markAllRead: z.boolean().optional(),
    /** Mark every unread notification referencing this entity id as read. */
    clearRef: z.string().optional(),
  })
  .refine((v) => v.notificationId || v.markAllRead || v.clearRef, {
    message: "Must specify notificationId, markAllRead, or clearRef",
  });

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const ListQuerySchema = z.object({
  /** ISO createdAt of the last row the client already has. */
  before: z.string().optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
});

const DeleteQuerySchema = z
  .object({
    id: z.string().optional(),
    clearRead: z.string().optional(),
  })
  .refine((v) => v.id || v.clearRead === "true", {
    message: "Must specify id or clearRead=true",
  });

export const GET = withTenant({ query: ListQuerySchema }, async ({ db, tenantUser, query }) => {
  // Cursor-based pagination: `before` is the ISO createdAt of the last row the
  // client already has — we return rows strictly older than that.
  const limit = query.limit ?? DEFAULT_LIMIT;

  let notificationQuery = db
    .from("notifications")
    .select("*, actor:tenant_users!notifications_actorId_fkey(id, fullName)")
    .eq("userId", tenantUser.id)
    .order("createdAt", { ascending: false })
    .limit(limit + 1); // fetch one extra to detect hasMore

  if (query.before) {
    notificationQuery = notificationQuery.lt("createdAt", query.before);
  }

  const { data, error } = await notificationQuery;
  if (error) throw new Error(error.message);

  const rows = data || [];
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? items[items.length - 1].createdAt : null;

  return { items, nextCursor, hasMore };
});

export const PUT = withTenant(
  { body: UpdateNotificationSchema },
  async ({ db, tenantUser, body }) => {
    const mine = () =>
      db.from("notifications").update({ isRead: true }).eq("userId", tenantUser.id);

    if (body.markAllRead) {
      const { error } = await mine().eq("isRead", false);
      if (error) throw new Error(error.message);
    } else if (body.clearRef) {
      // Auto-clear on entity navigation: when a user opens a BOM/ECO/file,
      // any unread notifications that reference it should stop nagging.
      const { error } = await mine().eq("refId", body.clearRef).eq("isRead", false);
      if (error) throw new Error(error.message);
    } else if (body.notificationId) {
      const { error } = await mine().eq("id", body.notificationId);
      if (error) throw new Error(error.message);
    }

    return { success: true };
  }
);

export const DELETE = withTenant(
  { query: DeleteQuerySchema },
  async ({ db, tenantUser, query }) => {
    const mine = () => db.from("notifications").delete().eq("userId", tenantUser.id);

    if (query.clearRead === "true") {
      // Bulk clear: only removes notifications the user has already read,
      // so unread items can't be wiped by accident.
      const { error } = await mine().eq("isRead", true);
      if (error) throw new Error(error.message);
    } else if (query.id) {
      const { error } = await mine().eq("id", query.id);
      if (error) throw new Error(error.message);
    } else {
      throw badRequest("Must specify id or clearRead=true");
    }

    return { success: true };
  }
);
