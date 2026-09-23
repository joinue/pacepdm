/**
 * Where a vault URL points, and how one is written.
 *
 * Pure and framework-free on purpose. The server page and the client
 * navigation hook both read the URL, and they have to read it the same way:
 * the page resolves what the URL names (the folder's ancestors, the first
 * requests to start) before the client has mounted.
 */

/** What the root crumb is called. The root folder's own name is never shown. */
export const VAULT_ROOT_NAME = "Vault";

/**
 * The flat (cross-folder) views the vault can render in place of the usual
 * folder listing. An open string enum so future flat views ("recent", "in
 * WIP", ...) slot in without reshaping the navigation state.
 */
export const FLAT_VIEWS = ["checkouts", "trash"] as const;
export type FlatView = (typeof FLAT_VIEWS)[number];
export type VaultViewMode = "folder" | FlatView;

export function isFlatView(value: string | null): value is FlatView {
  return value !== null && (FLAT_VIEWS as readonly string[]).includes(value);
}

export interface VaultLocation {
  viewMode: VaultViewMode;
  folderId: string;
  fileId: string | null;
}

/**
 * Read a vault URL.
 *
 * `file` is accepted as another spelling of `fileId`. Notification links were
 * written as `/vault?file=<id>` while the vault only read `fileId`, so every
 * "file released" or "checked in" notification opened the vault root instead
 * of the file, and those rows are already stored, so the old spelling has to
 * keep working after the link builders were corrected.
 */
export function readVaultLocation(
  params: Pick<URLSearchParams, "get">,
  rootFolderId: string
): VaultLocation {
  const view = params.get("view");
  return {
    viewMode: isFlatView(view) ? view : "folder",
    folderId: params.get("folderId") || rootFolderId,
    fileId: params.get("fileId") || params.get("file") || null,
  };
}

/** The `searchParams` a page receives, once awaited. */
export type PageSearchParams = Record<string, string | string[] | undefined>;

/** A page's `searchParams` object as the reader `readVaultLocation` wants. */
export function searchParamsFrom(params: PageSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string") out.set(key, first);
  }
  return out;
}

/**
 * Write a vault URL. `view` takes precedence over `folderId`: a flat view is
 * conceptually rootless, so the folder is left out while one is active. The
 * root folder is the default and is never spelled out.
 */
export function vaultHref(loc: VaultLocation, rootFolderId: string): string {
  const params = new URLSearchParams();
  if (loc.viewMode !== "folder") {
    params.set("view", loc.viewMode);
  } else if (loc.folderId !== rootFolderId) {
    params.set("folderId", loc.folderId);
  }
  if (loc.fileId) params.set("fileId", loc.fileId);
  const qs = params.toString();
  return `/vault${qs ? `?${qs}` : ""}`;
}

/**
 * The API requests the vault browser makes the moment it mounts at `loc`.
 *
 * The page emits these as preload hints so the browser starts them when the
 * document arrives, not after the client bundle has loaded and the mount
 * effect has run. They must match the URLs the hooks fetch character for
 * character, or the browser will not pair the preload with the request.
 */
export function initialVaultRequests(loc: VaultLocation): string[] {
  const urls: string[] = [];
  if (loc.viewMode === "checkouts") {
    urls.push("/api/files?checkedOutByMe=1");
  } else if (loc.viewMode === "trash") {
    urls.push("/api/files/deleted?offset=0");
  } else {
    urls.push(`/api/folders?parentId=${loc.folderId}`, `/api/files?folderId=${loc.folderId}`);
  }
  if (loc.fileId) {
    // Everything the detail panel loads on mount, in one Promise.all.
    urls.push(
      `/api/files/${loc.fileId}`,
      `/api/files/${loc.fileId}/where-used`,
      `/api/files/${loc.fileId}/revisions`,
      `/api/files/${loc.fileId}/parts`
    );
  }
  return urls;
}
