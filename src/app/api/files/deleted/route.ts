import { withTenant } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { getFolderAccessScope, canViewFolder } from "@/lib/folder-access";
import { z } from "@/lib/validation";

/**
 * GET /api/files/deleted — the trash.
 *
 * A flat cross-folder view of soft-deleted files, newest deletion first,
 * shaped for one purpose: deciding what to restore. It deliberately shares
 * nothing with `GET /api/files`, which is worth stating because the obvious
 * alternative was a `?deleted=1` flag on that route:
 *
 *   - that route is one of the remaining unwrapped handlers, and extending it
 *     would mean adding to the shape AGENTS.md says not to copy;
 *   - almost none of its work applies here. It backfills thumbnails inline,
 *     signs thumbnail URLs, joins the latest version, and attaches approval
 *     status. Generating thumbnails for deleted files would be wasted work at
 *     best and confusing at worst.
 *
 * So this is a small, wrapped route from the start, and converting the main
 * list later does not have to untangle two features at once.
 *
 * Gated on FILE_DELETE rather than FILE_VIEW: the actions available from this
 * view are restore and — for holders of FILE_PURGE — permanent deletion, so
 * showing it to someone who can do neither would be a dead end.
 */

/**
 * Page size. The list used to be capped at a flat 200 rows with no way to
 * reach anything past that, which was the actual bug: nothing purges the trash
 * (deliberately — see docs/decisions/retention-and-formats.md), so past 200
 * deletions the oldest rows stayed in the database while disappearing from the
 * UI. They were invisible, un-restorable and un-deletable through any supported
 * route. **A cap that hides data is worse than no cap, because it looks like
 * the data is gone.**
 */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const GET = withTenant(
  { permission: PERMISSIONS.FILE_DELETE, query: QuerySchema },
  async ({ db, tenantUser, query }) => {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const offset = query.offset ?? 0;

    /**
     * Offset rather than cursor pagination, deliberately.
     *
     * A cursor would have to be (deletedAt, id) compound: a bulk delete stamps
     * every file in the batch with the same timestamp, so a cursor on
     * `deletedAt` alone skips rows at a page boundary. That means an `.or()`
     * filter built from a client-supplied string, which is the one Supabase
     * builder that parses its argument as syntax rather than escaping it.
     *
     * Offset avoids both. Its known weakness — rows shifting if something is
     * restored mid-paging — is mild here and self-corrects on the refetch that
     * every restore already triggers.
     */
    const { data, error, count } = await db
      .from("files")
      .select(
        "id, name, folderId, fileType, category, currentVersion, lifecycleState, partNumber, " +
          "deletedAt, deletedById, " +
          "deletedBy:tenant_users!files_deletedById_fkey(fullName), " +
          "folder:folders!files_folderId_fkey(id, name, path)",
        { count: "exact" }
      )
      .not("deletedAt", "is", null)
      .order("deletedAt", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw new Error(error.message);

    // Post-filter by folder ACL, the same way the checked-out flat view does.
    // A file whose folder access was revoked after it was deleted must not
    // reappear here — the trash is not a way around the folder model.
    const scope = await getFolderAccessScope(tenantUser);
    const rows = (data ?? []) as unknown as Array<{ folderId: string }>;
    const files = rows.filter((f) => canViewFolder(scope, f.folderId));

    return {
      files,
      /**
       * Pre-ACL totals. `total` counts every deleted file in the tenant and
       * `hasMore` is computed from it, so paging continues correctly even when
       * the ACL filter empties a whole page — which it can, and which would
       * otherwise look like the end of the list.
       */
      total: count ?? 0,
      offset,
      limit,
      hasMore: offset + rows.length < (count ?? 0),
    };
  }
);
