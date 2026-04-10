"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { fetchJson, errorMessage, isAbortError } from "@/lib/api-client";
import type { FolderItem, FileItem } from "@/components/vault/vault-types";
import type { VaultViewMode } from "./use-vault-navigation";

/**
 * Identifies the source the contents hook should fetch from. `folder` is
 * the usual per-folder listing; other variants are flat cross-folder views
 * that don't have a folder tree and return files from many folders at once.
 */
export type VaultContentSource =
  | { kind: "folder"; folderId: string }
  | { kind: "checkouts" };

function sourceFromViewMode(
  viewMode: VaultViewMode,
  folderId: string
): VaultContentSource {
  if (viewMode === "checkouts") return { kind: "checkouts" };
  return { kind: "folder", folderId };
}

/**
 * Loads and stores the folders and files for the current view.
 *
 * Aborts in-flight requests when the source changes so stale responses
 * can't overwrite fresh ones (the original race condition the audit
 * flagged). In flat-view modes the folders array is always empty — flat
 * views show files from many folders at once, with no tree to navigate.
 */
export function useVaultContents(
  viewMode: VaultViewMode,
  currentFolderId: string
) {
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);

  const loadAbortRef = useRef<AbortController | null>(null);

  const fetchForSource = useCallback(
    async (source: VaultContentSource, signal: AbortSignal) => {
      if (source.kind === "folder") {
        const [foldersData, filesData] = await Promise.all([
          fetchJson<FolderItem[]>(`/api/folders?parentId=${source.folderId}`, { signal }),
          fetchJson<FileItem[]>(`/api/files?folderId=${source.folderId}`, { signal }),
        ]);
        return {
          folders: Array.isArray(foldersData) ? foldersData : [],
          files: Array.isArray(filesData) ? filesData : [],
        };
      }
      // Flat mode — no folder tree, only the filtered file list.
      const filesData = await fetchJson<FileItem[]>(
        "/api/files?checkedOutByMe=1",
        { signal }
      );
      return {
        folders: [] as FolderItem[],
        files: Array.isArray(filesData) ? filesData : [],
      };
    },
    []
  );

  const load = useCallback(
    async (source: VaultContentSource) => {
      loadAbortRef.current?.abort();
      const controller = new AbortController();
      loadAbortRef.current = controller;

      setLoading(true);
      try {
        const { folders: nextFolders, files: nextFiles } = await fetchForSource(
          source,
          controller.signal
        );
        setFolders(nextFolders);
        setFiles(nextFiles);
      } catch (err) {
        if (isAbortError(err)) return;
        toast.error(errorMessage(err) || "Failed to load vault contents");
      } finally {
        // Only clear loading if this is still the current request — guards
        // against an aborted load racing with the new one.
        if (loadAbortRef.current === controller) setLoading(false);
      }
    },
    [fetchForSource]
  );

  // `refresh` always re-loads the current source — callers after mutations
  // (upload, rename, check-in, …) use this and don't need to know whether
  // we're in folder mode or a flat view.
  const refresh = useCallback(
    () => load(sourceFromViewMode(viewMode, currentFolderId)),
    [load, viewMode, currentFolderId]
  );

  useEffect(() => {
    load(sourceFromViewMode(viewMode, currentFolderId));
  }, [viewMode, currentFolderId, load]);

  // Cleanup any pending request on unmount
  useEffect(() => {
    return () => loadAbortRef.current?.abort();
  }, []);

  return {
    folders,
    files,
    loading,
    refresh,
  };
}

export type VaultContents = ReturnType<typeof useVaultContents>;
