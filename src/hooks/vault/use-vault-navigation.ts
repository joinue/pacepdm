"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { fetchJson, isAbortError, errorMessage } from "@/lib/api-client";
import type { BreadcrumbEntry } from "@/components/vault/vault-types";

/**
 * Minimal shape `navigateToFolder` needs — just the destination's id and
 * display name. Accepting this (rather than the full `FolderItem`) lets
 * the detail panel and the flat-view "jump to folder" links trigger a
 * navigation without synthesizing unrelated fields like `_count`.
 */
type NavigableFolder = { id: string; name: string };

/**
 * The set of flat (cross-folder) views the vault can render in place of
 * the usual folder listing. The shape is an open string enum so future flat
 * views ("recent", "in WIP", etc.) can slot in without reshaping the
 * navigation state.
 */
export const FLAT_VIEWS = ["checkouts", "trash"] as const;
export type FlatView = (typeof FLAT_VIEWS)[number];
export type VaultViewMode = "folder" | FlatView;

function isFlatView(value: string | null): value is FlatView {
  return value !== null && (FLAT_VIEWS as readonly string[]).includes(value);
}

/** Where a vault URL points. */
export interface VaultLocation {
  viewMode: VaultViewMode;
  folderId: string;
  fileId: string | null;
}

/**
 * Read a vault URL.
 *
 * `file` is accepted as another spelling of `fileId`. Notification links were
 * written as `/vault?file=<id>` while this hook only read `fileId`, so every
 * "file released" or "checked in" notification opened the vault root instead
 * of the file — and those rows are already stored, so the old spelling has to
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

/**
 * Identity of a location for comparison. A flat view hides the folder from
 * the URL, so the folder is not part of a flat view's identity.
 */
function locationKey(loc: VaultLocation): string {
  return [loc.viewMode, loc.viewMode === "folder" ? loc.folderId : "", loc.fileId ?? ""].join("|");
}

/**
 * Vault navigation state and helpers.
 *
 * Manages the current folder, breadcrumb trail, the selected file ID, the
 * active view mode (folder listing vs a flat cross-folder view), and keeps
 * the URL query params in sync with all of them — in both directions. Also
 * resolves ancestor breadcrumbs on initial deep-link load.
 *
 * Split out from `useVaultBrowser` so navigation concerns are isolated
 * from contents loading, file actions, drag-and-drop, etc.
 */
export function useVaultNavigation(rootFolderId: string) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [initialLocation] = useState(() => readVaultLocation(searchParams, rootFolderId));
  const [viewMode, setViewMode] = useState<VaultViewMode>(initialLocation.viewMode);
  const [currentFolderId, setCurrentFolderId] = useState(initialLocation.folderId);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbEntry[]>([
    { id: rootFolderId, name: "Vault" },
  ]);
  const [selectedFile, setSelectedFile] = useState<string | null>(initialLocation.fileId);

  // Asked before any navigation that would close the open file. The detail
  // panel holds unsaved property edits, and every way out of it — the back
  // button, a breadcrumb, a flat view — used to drop them without a word.
  const leaveGuardRef = useRef<(() => boolean) | null>(null);
  /**
   * Register the check (or `null` to remove it). It returns true when leaving
   * is fine — nothing unsaved, or the user agreed to discard it.
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

  // URL is the source of truth for sharing/deep-linking, so every state
  // transition below routes through `updateUrl`. The `view` param takes
  // precedence over `folderId` — a flat view is conceptually rootless,
  // so we drop `folderId` while it's active.
  const updateUrl = useCallback(
    (mode: VaultViewMode, folderId: string, fileId: string | null) => {
      const key = locationKey({ viewMode: mode, folderId, fileId });
      if (key !== lastUrlKey.current) {
        pendingWrites.current = [...pendingWrites.current.slice(-9), key];
      }
      const params = new URLSearchParams();
      if (mode !== "folder") {
        params.set("view", mode);
      } else if (folderId !== rootFolderId) {
        params.set("folderId", folderId);
      }
      if (fileId) params.set("fileId", fileId);
      const qs = params.toString();
      router.replace(`/vault${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [rootFolderId, router]
  );

  // One breadcrumb request at a time: a newer navigation aborts the older one,
  // so a slow response cannot put the previous folder's trail back.
  const breadcrumbRequest = useRef<AbortController | null>(null);
  const loadBreadcrumbs = useCallback(
    (folderId: string) => {
      breadcrumbRequest.current?.abort();
      breadcrumbRequest.current = null;
      setBreadcrumbs([{ id: rootFolderId, name: "Vault" }]);
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
  // the query string — Cmd-K to a file or folder while already in the vault, a
  // notification link, the browser's back button — changed the address bar
  // and nothing on screen. A URL change the vault did not make is applied
  // here. Its own writes are recognised and skipped, so the two never fight.
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
        // If we were in a flat view, the crumb trail is meaningless — reset
        // it to just the root and the newly-entered folder. Otherwise append
        // as usual so descendants accumulate correctly.
        const base = prev[0]?.id === rootFolderId ? prev : [{ id: rootFolderId, name: "Vault" }];
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
   * state so exiting the view returns the user to where they were — the
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
   * (e.g., bookmarks `/vault?folderId=xyz`). Aborts on unmount. Skipped
   * entirely for flat-view deep links since there's no folder crumb trail
   * to build in that mode.
   */
  const hydrateBreadcrumbsFromDeepLink = useCallback(() => {
    const abort = () => breadcrumbRequest.current?.abort();
    if (initialLocation.viewMode !== "folder") return abort;
    if (initialLocation.folderId === rootFolderId) return abort;
    loadBreadcrumbs(initialLocation.folderId);
    return abort;
  }, [initialLocation, rootFolderId, loadBreadcrumbs]);

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
