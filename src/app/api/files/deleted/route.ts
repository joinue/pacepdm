import { withTenant } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { getFolderAccessScope, canViewFolder } from "@/lib/folder-access";

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
 * Gated on FILE_DELETE rather than FILE_VIEW: the only action available from
 * this view is restore, so showing it to someone who cannot restore would be
 * a dead end.
 */

/**
 * Deleted files accumulate without bound — nothing purges them today — so the
 * list is capped. If a tenant ever has more than this in the trash, the answer
 * is a purge policy and pagination, not a bigger number.
 */
const MAX_ROWS = 200;

export const GET = withTenant(
  { permission: PERMISSIONS.FILE_DELETE },
  async ({ db, tenantUser }) => {
    const { data, error } = await db
      .from("files")
      .select(
        "id, name, folderId, fileType, category, currentVersion, lifecycleState, partNumber, " +
          "deletedAt, deletedById, " +
          "deletedBy:tenant_users!files_deletedById_fkey(fullName), " +
          "folder:folders!files_folderId_fkey(id, name, path)"
      )
      .not("deletedAt", "is", null)
      .order("deletedAt", { ascending: false })
      .limit(MAX_ROWS);

    if (error) throw new Error(error.message);

    // Post-filter by folder ACL, the same way the checked-out flat view does.
    // A file whose folder access was revoked after it was deleted must not
    // reappear here — the trash is not a way around the folder model.
    const scope = await getFolderAccessScope(tenantUser);
    const rows = (data ?? []) as unknown as Array<{ folderId: string }>;
    return rows.filter((f) => canViewFolder(scope, f.folderId));
  }
);
