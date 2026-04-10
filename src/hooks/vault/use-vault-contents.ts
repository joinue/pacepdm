"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { fetchJson, errorMessage, isAbortError } from "@/lib/api-client";
import type { FolderItem, FileItem } from "@/components/vault/vault-types";

/**
 * Loads and stores the folders and files for the current folder.
 *
 * Aborts in-flight requests when the user navigates to a different folder
 * so stale responses can't overwrite fresh ones (the original race condition
 * the audit flagged).
 */
export function useVaultContents(currentFolderId: string) {
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);

  const loadAbortRef = useRef<AbortController | null>(null);

  const loadContents = useCallback(async (folderId: string) => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;

    setLoading(true);
    try {
      const [foldersData, filesData] = await Promise.all([
        fetchJson<FolderItem[]>(`/api/folders?parentId=${folderId}`, { signal: controller.signal }),
        fetchJson<FileItem[]>(`/api/files?folderId=${folderId}`, { signal: controller.signal }),
      ]);
      setFolders(Array.isArray(foldersData) ? foldersData : []);
      setFiles(Array.isArray(filesData) ? filesData : []);
    } catch (err) {
      if (isAbortError(err)) return;
      toast.error(errorMessage(err) || "Failed to load vault contents");
    } finally {
      // Only clear loading if this is still the current request — guards
      // against an aborted load racing with the new one.
      if (loadAbortRef.current === controller) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadContents(currentFolderId);
  }, [currentFolderId, loadContents]);

  // Cleanup any pending request on unmount
  useEffect(() => {
    return () => loadAbortRef.current?.abort();
  }, []);

  return {
    folders,
    files,
    loading,
    loadContents,
  };
}

export type VaultContents = ReturnType<typeof useVaultContents>;
