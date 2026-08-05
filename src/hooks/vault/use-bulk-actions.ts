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
  /** Drops a row locally and returns the rollback for a failed delete. */
  removeFile: (fileId: string) => () => void;
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
  removeFile,
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
    const toastId = toast.loading(`Preparing ${selectedFiles.size} files for download...`);
    try {
      const prep = await fetchJson<PrepareResponse>("/api/files/bulk-download/prepare", {
        method: "POST",
        body: { fileIds: [...selectedFiles] },
      });

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
      //
      // no-location-assign-relative-destination is a false positive here:
      // this is a download, not a navigation. router.push() would try to
      // client-side route to an API path and never hand off to the
      // browser's download manager.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
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

      // Download, not navigation — see the note in the bulk-download path.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = `/api/files/bulk-download/zip/${prep.token}`;
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to prepare folder download", { id: toastId });
    } finally {
      setFolderDownloading(false);
    }
  }, [canDownloadFolder, currentFolderId]);

  const handleBulkDelete = useCallback(async () => {
    const ids = [...selectedFiles];

    // Clear the rows and the confirm dialog up front. Each id keeps its own
    // rollback so a partial failure only restores the rows that survived.
    const rollbacks = new Map(ids.map((fid) => [fid, removeFile(fid)]));
    clearSelection();
    setShowBulkDeleteConfirm(false);

    const results = await Promise.allSettled(
      ids.map((fid) => fetchJson(`/api/files/${fid}/delete`, { method: "DELETE" }))
    );
    results.forEach((result, i) => {
      if (result.status === "rejected") rollbacks.get(ids[i])?.();
    });

    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed === 0) {
      toast.success(`${ids.length} file(s) deleted`);
    } else if (failed === ids.length) {
      toast.error(`Failed to delete ${failed} file(s)`);
    } else {
      toast.warning(`Deleted ${ids.length - failed} file(s), ${failed} failed`);
    }
    refresh();
  }, [selectedFiles, clearSelection, refresh, removeFile]);

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
