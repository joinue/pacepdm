import { preload } from "react-dom";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceClient } from "@/lib/db";
import { getCurrentTenantUser } from "@/lib/auth";
import { canViewFolder, getFolderAccessScope, type TenantUserForAccess } from "@/lib/folder-access";
import { getFolderAncestors } from "@/lib/folder-ancestors";
import { VaultBrowser } from "@/components/vault/vault-browser";
import {
  initialVaultRequests,
  readVaultLocation,
  searchParamsFrom,
  type PageSearchParams,
  type VaultLocation,
} from "@/components/vault/vault-location";

export default async function VaultPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const [tenantUser, params] = await Promise.all([getCurrentTenantUser(), searchParams]);
  const db = getServiceClient();

  const { data: rootFolder } = await db
    .from("folders")
    .select("id")
    .eq("tenantId", tenantUser.tenantId)
    .is("parentId", null)
    .single();
  const rootFolderId = rootFolder?.id ?? "";
  const location = readVaultLocation(searchParamsFrom(params), rootFolderId);

  // The browser's first requests, started from the document itself. Without
  // these the listing is asked for only after the client bundle has loaded,
  // hydrated and run its mount effect; with them the browser has it on the
  // way while that happens, and the mount effect's identical fetch is paired
  // with the response already arriving. `crossOrigin` is what makes the pair:
  // `fetch()` runs in CORS mode, and a preload without it does not.
  //
  // In-vault navigation writes the URL through `history.replaceState` and
  // does not re-render this page, so these fire once per visit, not per folder.
  for (const url of initialVaultRequests(location)) {
    preload(url, { as: "fetch", crossOrigin: "anonymous" });
  }

  const [{ data: metadataFields }, initialBreadcrumbs] = await Promise.all([
    db
      .from("metadata_fields")
      .select("id, name, fieldType, options, isRequired")
      .eq("tenantId", tenantUser.tenantId)
      .order("sortOrder"),
    resolveInitialTrail(db, tenantUser, location, rootFolderId),
  ]);

  return (
    <VaultBrowser
      rootFolderId={rootFolderId}
      initialBreadcrumbs={initialBreadcrumbs}
      metadataFields={(metadataFields || []).map((f) => ({
        id: f.id,
        name: f.name,
        fieldType: f.fieldType,
        options: f.options as string[] | null,
        isRequired: f.isRequired,
      }))}
    />
  );
}

/**
 * The breadcrumb trail for a deep link into a folder, so the heading renders
 * with the page instead of as "Vault" and then the real path a round trip
 * later. `null` at the root, in a flat view, or when the folder is not one the
 * caller may see. That last rule is the one `GET /api/folders/[id]` applies,
 * for the same reason: a trail names the ancestors of a folder whose
 * existence the caller is not meant to learn from its id.
 */
async function resolveInitialTrail(
  db: SupabaseClient,
  tenantUser: TenantUserForAccess,
  location: VaultLocation,
  rootFolderId: string
) {
  if (location.viewMode !== "folder" || location.folderId === rootFolderId) return null;
  const [trail, scope] = await Promise.all([
    getFolderAncestors(db, tenantUser.tenantId, location.folderId),
    getFolderAccessScope(tenantUser),
  ]);
  if (!trail || !canViewFolder(scope, location.folderId)) return null;
  return trail.ancestors;
}
