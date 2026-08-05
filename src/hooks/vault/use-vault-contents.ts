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
  { kind: "folder"; folderId: string } | { kind: "checkouts" } | { kind: "external" };

function sourceFromViewMode(viewMode: VaultViewMode, folderId: string): VaultContentSource {
  if (viewMode === "checkouts") return { kind: "checkouts" };
  // The trash renders from its own endpoint with its own row shape, and owns
  // that fetch itself (see `TrashList`). Declaring it as an `external` source
  // rather than letting it fall through to `folder` is what stops this hook
  // firing a pointless folder listing behind the trash view.
  if (viewMode === "trash") return { kind: "external" };
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
export function useVaultContents(viewMode: VaultViewMode, currentFolderId: string) {
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);

  const loadAbortRef = useRef<AbortController | null>(null);

  // Mirrors of the two lists, kept in step with every write below. The
  // optimistic helpers need to read the *current* list synchronously, which
  // state alone can't provide — a handler that fires twice in one tick would
  // otherwise snapshot stale rows.
  const filesRef = useRef<FileItem[]>([]);
  const foldersRef = useRef<FolderItem[]>([]);

  const commitFiles = useCallback((next: FileItem[]) => {
    filesRef.current = next;
    setFiles(next);
  }, []);

  const commitFolders = useCallback((next: FolderItem[]) => {
    foldersRef.current = next;
    setFolders(next);
  }, []);

  const fetchForSource = useCallback(async (source: VaultContentSource, signal: AbortSignal) => {
    // A view that loads its own data — nothing for this hook to fetch.
    if (source.kind === "external") {
      return { folders: [] as FolderItem[], files: [] as FileItem[] };
    }
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
    const filesData = await fetchJson<FileItem[]>("/api/files?checkedOutByMe=1", { signal });
    return {
      folders: [] as FolderItem[],
      files: Array.isArray(filesData) ? filesData : [],
    };
  }, []);

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
        commitFolders(nextFolders);
        commitFiles(nextFiles);
      } catch (err) {
        if (isAbortError(err)) return;
        toast.error(errorMessage(err) || "Failed to load vault contents");
      } finally {
        // Only clear loading if this is still the current request — guards
        // against an aborted load racing with the new one.
        if (loadAbortRef.current === controller) setLoading(false);
      }
    },
    [fetchForSource, commitFiles, commitFolders]
  );

  // `refresh` always re-loads the current source — callers after mutations
  // (upload, rename, check-in, …) use this and don't need to know whether
  // we're in folder mode or a flat view.
  const refresh = useCallback(
    () => load(sourceFromViewMode(viewMode, currentFolderId)),
    [load, viewMode, currentFolderId]
  );

  // ─── Optimistic edits ────────────────────────────────────────────────────
  //
  // Each helper applies the expected result of a mutation to the local list
  // straight away and returns a rollback for the failure path. Rollbacks are
  // deliberately row-scoped rather than whole-list snapshots: a realtime
  // event or a concurrent refresh may have landed in between, and restoring
  // a stale snapshot would clobber it.

  const patchFile = useCallback(
    (fileId: string, patch: Partial<FileItem>): (() => void) => {
      const before = filesRef.current.find((f) => f.id === fileId);
      if (!before) return () => {};

      commitFiles(filesRef.current.map((f) => (f.id === fileId ? { ...f, ...patch } : f)));

      return () => {
        commitFiles(filesRef.current.map((f) => (f.id === fileId ? before : f)));
      };
    },
    [commitFiles]
  );

  const removeFile = useCallback(
    (fileId: string): (() => void) => {
      const index = filesRef.current.findIndex((f) => f.id === fileId);
      if (index === -1) return () => {};
      const removed = filesRef.current[index];

      commitFiles(filesRef.current.filter((f) => f.id !== fileId));

      return () => {
        // A refresh may already have restored the row; re-inserting would
        // duplicate it.
        if (filesRef.current.some((f) => f.id === fileId)) return;
        const current = filesRef.current;
        commitFiles([...current.slice(0, index), removed, ...current.slice(index)]);
      };
    },
    [commitFiles]
  );

  const patchFolder = useCallback(
    (folderId: string, patch: Partial<FolderItem>): (() => void) => {
      const before = foldersRef.current.find((f) => f.id === folderId);
      if (!before) return () => {};

      commitFolders(foldersRef.current.map((f) => (f.id === folderId ? { ...f, ...patch } : f)));

      return () => {
        commitFolders(foldersRef.current.map((f) => (f.id === folderId ? before : f)));
      };
    },
    [commitFolders]
  );

  const removeFolder = useCallback(
    (folderId: string): (() => void) => {
      const index = foldersRef.current.findIndex((f) => f.id === folderId);
      if (index === -1) return () => {};
      const removed = foldersRef.current[index];

      commitFolders(foldersRef.current.filter((f) => f.id !== folderId));

      return () => {
        if (foldersRef.current.some((f) => f.id === folderId)) return;
        const current = foldersRef.current;
        commitFolders([...current.slice(0, index), removed, ...current.slice(index)]);
      };
    },
    [commitFolders]
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
    patchFile,
    removeFile,
    patchFolder,
    removeFolder,
  };
}

export type VaultContents = ReturnType<typeof useVaultContents>;
