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

// A heads-up, not a limit: the server refuses anything over its cap at
// prepare, with a reason. Past this size the download will take a while.
const WARN_BYTES = 250 * 1024 * 1024;

export const BULK_ZIP_URL = "/api/files/bulk-download/zip";

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
  count: number;
  totalBytes: number;
  /** Selected files that no longer exist or are hidden from the caller. */
  skipped?: number;
}

interface FolderPrepareResponse extends PrepareResponse {
  rootName: string;
}

/**
 * Hand a zip to the browser's download manager.
 *
 * Submits a hidden form, so the selection travels in the request body and the
 * URL is the same for two files or a thousand. It used to be a GET with a
 * signed token in the path that grew ~260 bytes per file, which failed with a
 * 414 or 431 at around fifty. The response is `Content-Disposition:
 * attachment`, so the form navigation becomes a download and the page stays
 * where it is: native progress, native save, nothing held in JS memory.
 */
function submitZipForm(action: string, fields: [name: string, value: string][]) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = action;
  form.hidden = true;
  for (const [name, value] of fields) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.append(form);
  form.submit();
  form.remove();
}

/**
 * Bulk file operations: delete and zip-download.
 *
 * Bulk delete uses Promise.allSettled and reports per-file outcomes
 * so partial failures are visible (the audit found this was previously
 * a silent for-loop with no error reporting).
 *
 * Zip download is two steps. `prepare` checks the selection and answers with
 * its size, or with a reason it cannot be zipped, so the user sees that as a
 * toast. Then a form POST of the same selection streams the archive from the
 * server, which checks access again as the bytes go out — the browser never
 * holds the archive in memory. The previous client-zip implementation OOMed on
 * selections of any non-trivial size.
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

    const fileIds = [...selectedFiles];
    setBulkDownloading(true);
    const toastId = toast.loading(`Preparing ${fileIds.length} files for download...`);
    try {
      const prep = await fetchJson<PrepareResponse>("/api/files/bulk-download/prepare", {
        method: "POST",
        body: { fileIds },
      });

      const head = `${prep.count} file${prep.count === 1 ? "" : "s"}, ${formatBytes(prep.totalBytes)}`;
      const skipped = prep.skipped
        ? `${prep.skipped} selected file${prep.skipped === 1 ? " is" : "s are"} no longer available and will be left out.`
        : undefined;
      if (prep.totalBytes >= WARN_BYTES) {
        toast.message(`Large download: ${head}`, {
          id: toastId,
          description: skipped ?? "This may take a few minutes to save.",
        });
      } else {
        toast.success(`Starting download — ${head}`, { id: toastId, description: skipped });
      }

      submitZipForm(
        BULK_ZIP_URL,
        fileIds.map((id) => ["fileId", id])
      );
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
      const base = `/api/folders/${encodeURIComponent(currentFolderId)}/download`;
      const prep = await fetchJson<FolderPrepareResponse>(`${base}/prepare`, { method: "POST" });

      const sizeLabel = formatBytes(prep.totalBytes);
      const head = `${prep.rootName} — ${prep.count} file${prep.count === 1 ? "" : "s"}, ${sizeLabel}`;
      if (prep.totalBytes >= WARN_BYTES) {
        toast.message(`Large download: ${head}`, {
          id: toastId,
          description: "This may take a few minutes to save.",
        });
      } else {
        toast.success(`Starting download — ${head}`, { id: toastId });
      }

      submitZipForm(`${base}/zip`, []);
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
