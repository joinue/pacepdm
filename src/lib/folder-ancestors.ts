import type { SupabaseClient } from "@supabase/supabase-js";
import { VAULT_ROOT_NAME } from "@/components/vault/vault-location";

export interface FolderRow {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  tenantId: string;
}

export interface FolderTrail {
  folder: FolderRow;
  /** `[Vault, ..., parent, folder]`: the folder itself is the last entry. */
  ancestors: { id: string; name: string }[];
}

type FolderReader = Pick<SupabaseClient, "from">;

async function loadFolder(
  db: FolderReader,
  tenantId: string,
  folderId: string
): Promise<FolderRow | null> {
  const { data } = await db
    .from("folders")
    .select("id, name, parentId, path, tenantId")
    .eq("id", folderId)
    .eq("tenantId", tenantId)
    .single();
  return (data as FolderRow | null) ?? null;
}

/**
 * A folder and its trail from the vault root. `null` when the folder is not
 * in the tenant.
 *
 * Used by `GET /api/folders/[id]` and by the vault page, which resolves the
 * trail for a deep link before the client mounts so the heading does not
 * render as "Vault" and then snap to the real path a round trip later.
 *
 * Walks parent by parent, one small query per level, rather than splitting
 * `path`, which a folder named with a "/" would break. Every step is filtered
 * by tenant; the tree's own integrity is not what keeps the walk inside it.
 * A parent chain that loops (corrupt data) ends the walk instead of hanging
 * the request.
 */
export async function getFolderAncestors(
  db: FolderReader,
  tenantId: string,
  folderId: string
): Promise<FolderTrail | null> {
  const folder = await loadFolder(db, tenantId, folderId);
  if (!folder) return null;

  const ancestors = [{ id: folder.id, name: crumbName(folder) }];
  const seen = new Set([folder.id]);
  let parentId = folder.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = await loadFolder(db, tenantId, parentId);
    if (!parent) break;
    ancestors.unshift({ id: parent.id, name: crumbName(parent) });
    parentId = parent.parentId;
  }
  return { folder, ancestors };
}

function crumbName(folder: Pick<FolderRow, "name" | "parentId">): string {
  return folder.parentId ? folder.name : VAULT_ROOT_NAME;
}
