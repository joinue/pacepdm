"use client";

import { useState, useCallback } from "react";
import { toast } from "sonner";
import { fetchJson, errorMessage } from "@/lib/api-client";

interface UseBulkActionsOptions {
  selectedFiles: Set<string>;
  clearSelection: () => void;
  refresh: () => void;
  /** Single-file fallback for when only one file is selected. */
  downloadSingle: (fileId: string) => Promise<void>;
  /** Current folder being viewed; used by the folder-download action. */
  currentFolderId: string;
  /** Vault root; folder download is disabled at the root to avoid
   *  accidentally pulling down everything. */
  rootFolderId: string;
}

// Soft warning when an archive crosses 1 GiB. Just an informational toast —
// the 10 GiB hard cap lives on the server, so this is purely a heads-up so
// engineers don't get surprised by a multi-minute download.
const WARN_BYTES = 1 * 1024 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 ? 0 : 1)} ${units[i]}`;
}

interface PrepareResponse {
  token: string;
  count: number;
  totalBytes: number;
}

interface FolderPrepareResponse extends PrepareResponse {
  rootName: string;
}

/**
 * Bulk file operations: delete and zip-download.
 *
 * Bulk delete uses Promise.allSettled and reports per-file outcomes
 * so partial failures are visible (the audit found this was previously
 * a silent for-loop with no error reporting).
 *
 * Zip download uses the server-side streaming endpoint
 * (/api/files/bulk-download/prepare → GET /zip/[token]) so the browser
 * never holds the full archive in memory. The previous client-zip
 * implementation OOMed on selections of any non-trivial size.
 */
export function useBulkActions({
  selectedFiles,
  clearSelection,
  refresh,
  downloadSingle,
  currentFolderId,
  rootFolderId,
}: UseBulkActionsOptions) {
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [bulkDownloading, setBulkDownloading] = useState(false);
  const [folderDownloading, setFolderDownloading] = useState(false);
  const canDownloadFolder = currentFolderId !== rootFolderId;

  const handleBulkDownload = useCallback(async () => {
    if (selectedFiles.size === 0) return;

    // Single file: skip the zip overhead entirely.
    if (selectedFiles.size === 1) {
      await downloadSingle([...selectedFiles][0]);
      return;
    }

    setBulkDownloading(true);
    const toastId = toast.loading(
      `Preparing ${selectedFiles.size} files for download...`
    );
    try {
      const prep = await fetchJson<PrepareResponse>(
        "/api/files/bulk-download/prepare",
        { method: "POST", body: { fileIds: [...selectedFiles] } }
      );

      const sizeLabel = formatBytes(prep.totalBytes);
      if (prep.totalBytes >= WARN_BYTES) {
        toast.message(`Large download: ${sizeLabel}`, {
          id: toastId,
          description: "Your browser will start saving the file shortly.",
        });
      } else {
        toast.success(`Starting download (${sizeLabel})`, { id: toastId });
      }

      // Native browser download — no JS memory pressure, native progress
      // bar, native save dialog. The signed token in the URL is the auth.
      window.location.href = `/api/files/bulk-download/zip/${prep.token}`;
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to prepare download", { id: toastId });
    } finally {
      setBulkDownloading(false);
    }
  }, [selectedFiles, downloadSingle]);

  const handleFolderDownload = useCallback(async () => {
    if (!canDownloadFolder) return;
    setFolderDownloading(true);
    const toastId = toast.loading("Preparing folder for download...");
    try {
      const prep = await fetchJson<FolderPrepareResponse>(
        `/api/folders/${currentFolderId}/download/prepare`,
        { method: "POST" }
      );

      const sizeLabel = formatBytes(prep.totalBytes);
      const head = `${prep.rootName} — ${prep.count} file${prep.count === 1 ? "" : "s"}, ${sizeLabel}`;
      if (prep.totalBytes >= WARN_BYTES) {
        toast.message(`Large download: ${head}`, {
          id: toastId,
          description: "Your browser will start saving the file shortly.",
        });
      } else {
        toast.success(`Starting download — ${head}`, { id: toastId });
      }

      window.location.href = `/api/files/bulk-download/zip/${prep.token}`;
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to prepare folder download", { id: toastId });
    } finally {
      setFolderDownloading(false);
    }
  }, [canDownloadFolder, currentFolderId]);

  const handleBulkDelete = useCallback(async () => {
    const ids = [...selectedFiles];
    const results = await Promise.allSettled(
      ids.map((fid) => fetchJson(`/api/files/${fid}/delete`, { method: "DELETE" }))
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed === 0) {
      toast.success(`${ids.length} file(s) deleted`);
    } else if (failed === ids.length) {
      toast.error(`Failed to delete ${failed} file(s)`);
    } else {
      toast.warning(`Deleted ${ids.length - failed} file(s), ${failed} failed`);
    }
    clearSelection();
    setShowBulkDeleteConfirm(false);
    refresh();
  }, [selectedFiles, clearSelection, refresh]);

  return {
    showBulkDeleteConfirm,
    setShowBulkDeleteConfirm,
    bulkDownloading,
    handleBulkDownload,
    handleBulkDelete,
    canDownloadFolder,
    folderDownloading,
    handleFolderDownload,
  };
}
