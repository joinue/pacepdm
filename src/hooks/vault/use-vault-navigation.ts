"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { fetchJson, isAbortError, errorMessage } from "@/lib/api-client";
import type { BreadcrumbEntry } from "@/components/vault/vault-types";
import {
  VAULT_ROOT_NAME,
  readVaultLocation,
  vaultHref,
  type FlatView,
  type VaultLocation,
  type VaultViewMode,
} from "@/components/vault/vault-location";

// The URL vocabulary lives in `vault-location.ts` so the server page can read
// it too; re-exported here for the callers that always imported it from the hook.
export {
  FLAT_VIEWS,
  readVaultLocation,
  type FlatView,
  type VaultLocation,
  type VaultViewMode,
} from "@/components/vault/vault-location";

/**
 * Minimal shape `navigateToFolder` needs: just the destination's id and
 * display name. Accepting this (rather than the full `FolderItem`) lets
 * the detail panel and the flat-view "jump to folder" links trigger a
 * navigation without synthesizing unrelated fields like `_count`.
 */
type NavigableFolder = { id: string; name: string };

export interface VaultNavigationOptions {
  /**
   * The breadcrumb trail for the folder the URL opened on, resolved by the
   * server page. Used as the initial trail when it describes that folder;
   * otherwise ignored and the trail is fetched as for any deep link.
   */
  initialBreadcrumbs?: BreadcrumbEntry[] | null;
}

/**
 * Identity of a location for comparison. A flat view hides the folder from
 * the URL, so the folder is not part of a flat view's identity.
 */
function locationKey(loc: VaultLocation): string {
  return [loc.viewMode, loc.viewMode === "folder" ? loc.folderId : "", loc.fileId ?? ""].join("|");
}

function rootTrail(rootFolderId: string): BreadcrumbEntry[] {
  return [{ id: rootFolderId, name: VAULT_ROOT_NAME }];
}

/**
 * The server's trail is only usable when it is the trail for the folder the
 * URL names, from the root this vault knows. Anything else (a stale prop, a
 * flat view, a folder that was moved between render and mount) falls back to
 * the fetch.
 */
function usableServerTrail(
  provided: BreadcrumbEntry[] | null | undefined,
  loc: VaultLocation,
  rootFolderId: string
): BreadcrumbEntry[] | null {
  if (!provided || provided.length === 0) return null;
  if (loc.viewMode !== "folder") return null;
  if (provided[0].id !== rootFolderId) return null;
  if (provided[provided.length - 1].id !== loc.folderId) return null;
  return provided;
}

/**
 * Vault navigation state and helpers.
 *
 * Manages the current folder, breadcrumb trail, the selected file ID, the
 * active view mode (folder listing vs a flat cross-folder view), and keeps
 * the URL query params in sync with all of them, in both directions. Also
 * resolves ancestor breadcrumbs on initial deep-link load.
 *
 * Split out from `useVaultBrowser` so navigation concerns are isolated
 * from contents loading, file actions, drag-and-drop, etc.
 */
export function useVaultNavigation(rootFolderId: string, options: VaultNavigationOptions = {}) {
  const searchParams = useSearchParams();

  const [initial] = useState(() => {
    const location = readVaultLocation(searchParams, rootFolderId);
    const serverTrail = usableServerTrail(options.initialBreadcrumbs, location, rootFolderId);
    return { location, serverTrail };
  });
  const initialLocation = initial.location;
  const [viewMode, setViewMode] = useState<VaultViewMode>(initialLocation.viewMode);
  const [currentFolderId, setCurrentFolderId] = useState(initialLocation.folderId);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbEntry[]>(
    () => initial.serverTrail ?? rootTrail(rootFolderId)
  );
  const [selectedFile, setSelectedFile] = useState<string | null>(initialLocation.fileId);

  // Asked before any navigation that would close the open file. The detail
  // panel holds unsaved property edits, and every way out of it (the back
  // button, a breadcrumb, a flat view) used to drop them without a word.
  const leaveGuardRef = useRef<(() => boolean) | null>(null);
  /**
   * Register the check (or `null` to remove it). It returns true when leaving
   * is fine: nothing unsaved, or the user agreed to discard it.
   */
  const setLeaveGuard = useCallback((guard: (() => boolean) | null) => {
    leaveGuardRef.current = guard;
  }, []);
  const mayLeaveFile = useCallback(() => leaveGuardRef.current?.() ?? true, []);

  // The last URL location this hook has seen, and the ones it has written
  // itself but not yet seen come back. Together they tell the vault's own
  // navigation apart from a navigation that arrived from outside.
  const lastUrlKey = useRef(locationKey(initialLocation));
  const pendingWrites = useRef<string[]>([]);

  // The URL is the source of truth for sharing and deep-linking, so every
  // state transition below routes through `updateUrl`.
  //
  // Written with `window.history.replaceState`, which Next's router picks up
  // (`useSearchParams` follows it), and not `router.replace`. The vault page
  // is dynamic, so a router navigation to the same page with a new query
  // string re-renders it on the server: the session is resolved again and the
  // page's queries run again, for props that do not change. Every folder
  // opened cost that round trip on top of the listing it actually needed.
  const updateUrl = useCallback(
    (mode: VaultViewMode, folderId: string, fileId: string | null) => {
      const loc = { viewMode: mode, folderId, fileId };
      const key = locationKey(loc);
      if (key !== lastUrlKey.current) {
        pendingWrites.current = [...pendingWrites.current.slice(-9), key];
      }
      if (typeof window !== "undefined") {
        window.history.replaceState(null, "", vaultHref(loc, rootFolderId));
      }
    },
    [rootFolderId]
  );

  // One breadcrumb request at a time: a newer navigation aborts the older one,
  // so a slow response cannot put the previous folder's trail back.
  const breadcrumbRequest = useRef<AbortController | null>(null);
  const loadBreadcrumbs = useCallback(
    (folderId: string) => {
      breadcrumbRequest.current?.abort();
      breadcrumbRequest.current = null;
      setBreadcrumbs(rootTrail(rootFolderId));
      if (folderId === rootFolderId) return;

      const controller = new AbortController();
      breadcrumbRequest.current = controller;
      fetchJson<{ ancestors?: BreadcrumbEntry[] }>(`/api/folders/${folderId}`, {
        signal: controller.signal,
      })
        .then((data) => {
          if (!controller.signal.aborted && data.ancestors) setBreadcrumbs(data.ancestors);
        })
        .catch((err) => {
          if (!isAbortError(err)) {
            console.warn("Failed to load breadcrumbs:", errorMessage(err));
          }
        });
    },
    [rootFolderId]
  );

  // ─── Following the URL ───────────────────────────────────────────────
  //
  // State was initialised from the URL once, so a navigation that changed only
  // the query string (Cmd-K to a file or folder while already in the vault, a
  // notification link, the browser's back button) changed the address bar and
  // nothing on screen. A URL change the vault did not make is applied here.
  // Its own writes are recognised and skipped, so the two never fight.
  useEffect(() => {
    const loc = readVaultLocation(searchParams, rootFolderId);
    const key = locationKey(loc);
    if (key === lastUrlKey.current) return;
    lastUrlKey.current = key;

    const own = pendingWrites.current.indexOf(key);
    if (own !== -1) {
      pendingWrites.current = pendingWrites.current.slice(own + 1);
      return;
    }
    pendingWrites.current = [];

    const current = { viewMode, folderId: currentFolderId, fileId: selectedFile };
    if (key === locationKey(current)) return;

    // Leaving an open file with unsaved edits: ask, and if the answer is to
    // stay, put the address back where the screen is.
    if (selectedFile !== null && loc.fileId !== selectedFile && !mayLeaveFile()) {
      updateUrl(viewMode, currentFolderId, selectedFile);
      return;
    }

    // The URL is the outside system here and the state has to follow it.
    // Deferred past the effect body, as elsewhere in the app, to satisfy
    // react-hooks/set-state-in-effect.
    queueMicrotask(() => {
      setViewMode(loc.viewMode);
      // A flat view's URL carries no folder; the folder to return to is kept.
      if (loc.viewMode === "folder" && loc.folderId !== currentFolderId) {
        setCurrentFolderId(loc.folderId);
        loadBreadcrumbs(loc.folderId);
      }
      setSelectedFile(loc.fileId);
    });
  }, [
    searchParams,
    rootFolderId,
    viewMode,
    currentFolderId,
    selectedFile,
    mayLeaveFile,
    updateUrl,
    loadBreadcrumbs,
  ]);

  const navigateToFolder = useCallback(
    (folder: NavigableFolder) => {
      if (!mayLeaveFile()) return;
      setViewMode("folder");
      setCurrentFolderId(folder.id);
      setBreadcrumbs((prev) => {
        // If we were in a flat view, the crumb trail is meaningless: reset
        // it to just the root and the newly-entered folder. Otherwise append
        // as usual so descendants accumulate correctly.
        const base = prev[0]?.id === rootFolderId ? prev : rootTrail(rootFolderId);
        return [...base, { id: folder.id, name: folder.name }];
      });
      setSelectedFile(null);
      updateUrl("folder", folder.id, null);
    },
    [rootFolderId, updateUrl, mayLeaveFile]
  );

  const navigateToBreadcrumb = useCallback(
    (index: number) => {
      if (!mayLeaveFile()) return;
      const next = breadcrumbs.slice(0, index + 1);
      const entry = next[next.length - 1];
      setViewMode("folder");
      setBreadcrumbs(next);
      setCurrentFolderId(entry.id);
      setSelectedFile(null);
      updateUrl("folder", entry.id, null);
    },
    [breadcrumbs, updateUrl, mayLeaveFile]
  );

  /**
   * Open a file, or close the open one with `null`. `force` skips the leave
   * check, for when the file is gone anyway (it was just deleted).
   */
  const selectFile = useCallback(
    (fileId: string | null, options: { force?: boolean } = {}) => {
      if (fileId !== selectedFile && !options.force && !mayLeaveFile()) return;
      setSelectedFile(fileId);
      updateUrl(viewMode, currentFolderId, fileId);
    },
    [viewMode, currentFolderId, updateUrl, selectedFile, mayLeaveFile]
  );

  /**
   * Enter a flat cross-folder view. The current folder is preserved in
   * state so exiting the view returns the user to where they were; the
   * URL just hides it while the flat view is active.
   */
  const enterFlatView = useCallback(
    (view: FlatView) => {
      if (!mayLeaveFile()) return;
      setViewMode(view);
      setSelectedFile(null);
      updateUrl(view, currentFolderId, null);
    },
    [currentFolderId, updateUrl, mayLeaveFile]
  );

  /**
   * Leave the current flat view and return to folder-listing mode at
   * whatever folder the user was in before entering the flat view.
   */
  const exitFlatView = useCallback(() => {
    if (!mayLeaveFile()) return;
    setViewMode("folder");
    setSelectedFile(null);
    updateUrl("folder", currentFolderId, null);
  }, [currentFolderId, updateUrl, mayLeaveFile]);

  /**
   * Hydrates the breadcrumb trail when a user deep-links to a nested folder
   * (e.g., bookmarks `/vault?folderId=xyz`) and the server page did not
   * already supply it. Aborts on unmount. Skipped entirely for flat-view deep
   * links since there's no folder crumb trail to build in that mode.
   */
  const hydrateBreadcrumbsFromDeepLink = useCallback(() => {
    const abort = () => breadcrumbRequest.current?.abort();
    if (initial.serverTrail) return abort;
    if (initialLocation.viewMode !== "folder") return abort;
    if (initialLocation.folderId === rootFolderId) return abort;
    loadBreadcrumbs(initialLocation.folderId);
    return abort;
  }, [initial.serverTrail, initialLocation, rootFolderId, loadBreadcrumbs]);

  return {
    viewMode,
    currentFolderId,
    setCurrentFolderId,
    breadcrumbs,
    setBreadcrumbs,
    selectedFile,
    selectFile,
    navigateToFolder,
    navigateToBreadcrumb,
    enterFlatView,
    exitFlatView,
    hydrateBreadcrumbsFromDeepLink,
    setLeaveGuard,
  };
}

export type VaultNavigation = ReturnType<typeof useVaultNavigation>;
