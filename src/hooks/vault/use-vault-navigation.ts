"use client";

import { useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { fetchJson, isAbortError, errorMessage } from "@/lib/api-client";
import type { FolderItem, BreadcrumbEntry } from "@/components/vault/vault-types";

/**
 * Vault navigation state and helpers.
 *
 * Manages the current folder, breadcrumb trail, the selected file ID, and
 * keeps the URL query params in sync with both. Also resolves ancestor
 * breadcrumbs on initial deep-link load.
 *
 * Split out from `useVaultBrowser` so the navigation concerns are
 * isolated from contents loading, file actions, drag-and-drop, etc.
 */
export function useVaultNavigation(rootFolderId: string) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [currentFolderId, setCurrentFolderId] = useState(
    searchParams.get("folderId") || rootFolderId
  );
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbEntry[]>([
    { id: rootFolderId, name: "Vault" },
  ]);
  const [selectedFile, setSelectedFile] = useState<string | null>(
    searchParams.get("fileId") || null
  );

  const updateUrl = useCallback(
    (folderId: string, fileId: string | null) => {
      const params = new URLSearchParams();
      if (folderId !== rootFolderId) params.set("folderId", folderId);
      if (fileId) params.set("fileId", fileId);
      const qs = params.toString();
      router.replace(`/vault${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [rootFolderId, router]
  );

  const navigateToFolder = useCallback(
    (folder: FolderItem) => {
      setCurrentFolderId(folder.id);
      setBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
      setSelectedFile(null);
      updateUrl(folder.id, null);
    },
    [updateUrl]
  );

  const navigateToBreadcrumb = useCallback(
    (index: number) => {
      setBreadcrumbs((prev) => {
        const next = prev.slice(0, index + 1);
        const entry = next[next.length - 1];
        setCurrentFolderId(entry.id);
        setSelectedFile(null);
        updateUrl(entry.id, null);
        return next;
      });
    },
    [updateUrl]
  );

  const selectFile = useCallback(
    (fileId: string | null) => {
      setSelectedFile(fileId);
      updateUrl(currentFolderId, fileId);
    },
    [currentFolderId, updateUrl]
  );

  /**
   * Hydrates the breadcrumb trail when a user deep-links to a nested folder
   * (e.g., bookmarks `/vault?folderId=xyz`). Aborts on unmount.
   */
  const hydrateBreadcrumbsFromDeepLink = useCallback(() => {
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
  }, [searchParams, rootFolderId]);

  return {
    currentFolderId,
    setCurrentFolderId,
    breadcrumbs,
    setBreadcrumbs,
    selectedFile,
    selectFile,
    navigateToFolder,
    navigateToBreadcrumb,
    hydrateBreadcrumbsFromDeepLink,
  };
}

export type VaultNavigation = ReturnType<typeof useVaultNavigation>;
