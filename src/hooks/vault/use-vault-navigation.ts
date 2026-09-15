"use client";

import { useState, useCallback, useRef } from "react";
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

/**
 * Vault navigation state and helpers.
 *
 * Manages the current folder, breadcrumb trail, the selected file ID, the
 * active view mode (folder listing vs a flat cross-folder view), and keeps
 * the URL query params in sync with all of them. Also resolves ancestor
 * breadcrumbs on initial deep-link load.
 *
 * Split out from `useVaultBrowser` so navigation concerns are isolated
 * from contents loading, file actions, drag-and-drop, etc.
 */
export function useVaultNavigation(rootFolderId: string) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const initialViewParam = searchParams.get("view");
  const initialViewMode: VaultViewMode = isFlatView(initialViewParam) ? initialViewParam : "folder";

  const [viewMode, setViewMode] = useState<VaultViewMode>(initialViewMode);
  const [currentFolderId, setCurrentFolderId] = useState(
    searchParams.get("folderId") || rootFolderId
  );
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbEntry[]>([
    { id: rootFolderId, name: "Vault" },
  ]);
  const [selectedFile, setSelectedFile] = useState<string | null>(
    searchParams.get("fileId") || null
  );

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

  // URL is the source of truth for sharing/deep-linking, so every state
  // transition below routes through `updateUrl`. The `view` param takes
  // precedence over `folderId` — a flat view is conceptually rootless,
  // so we drop `folderId` while it's active.
  const updateUrl = useCallback(
    (mode: VaultViewMode, folderId: string, fileId: string | null) => {
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
    if (initialViewMode !== "folder") return () => {};
    const paramFolderId = searchParams.get("folderId");
    if (!paramFolderId || paramFolderId === rootFolderId) return () => {};

    const controller = new AbortController();
    fetchJson<{ ancestors?: BreadcrumbEntry[] }>(`/api/folders/${paramFolderId}`, {
      signal: controller.signal,
    })
      .then((data) => {
        if (data.ancestors) setBreadcrumbs(data.ancestors);
      })
      .catch((err) => {
        if (!isAbortError(err)) {
          console.warn("Failed to load breadcrumbs:", errorMessage(err));
        }
      });
    return () => controller.abort();
  }, [initialViewMode, searchParams, rootFolderId]);

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
