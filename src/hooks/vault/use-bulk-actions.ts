"use client";

import { useState, useCallback } from "react";
import { toast } from "sonner";
import { zipSync } from "fflate";
import { fetchJson, errorMessage } from "@/lib/api-client";

interface UseBulkActionsOptions {
  selectedFiles: Set<string>;
  clearSelection: () => void;
  refresh: () => void;
  /** Single-file fallback for when only one file is selected. */
  downloadSingle: (fileId: string) => Promise<void>;
}

/**
 * Bulk file operations: delete and zip-download.
 *
 * Bulk delete uses Promise.allSettled and reports per-file outcomes
 * so partial failures are visible (the audit found this was previously
 * a silent for-loop with no error reporting).
 */
export function useBulkActions({
  selectedFiles,
  clearSelection,
  refresh,
  downloadSingle,
}: UseBulkActionsOptions) {
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [bulkDownloading, setBulkDownloading] = useState(false);

  const handleBulkDownload = useCallback(async () => {
    if (selectedFiles.size === 0) return;

    // Single file: skip the zip overhead
    if (selectedFiles.size === 1) {
      await downloadSingle([...selectedFiles][0]);
      return;
    }

    setBulkDownloading(true);
    const toastId = toast.loading(`Preparing ${selectedFiles.size} files for download...`);
    try {
      const { files: fileUrls } = await fetchJson<{ files: { name: string; url: string }[] }>(
        "/api/files/bulk-download",
        { method: "POST", body: { fileIds: [...selectedFiles] } }
      );

      // Fetch all files in parallel
      const downloads = await Promise.all(
        fileUrls.map(async (f) => {
          const resp = await fetch(f.url);
          if (!resp.ok) throw new Error(`Failed to download ${f.name}`);
          const buffer = await resp.arrayBuffer();
          return { name: f.name, data: new Uint8Array(buffer) };
        })
      );

      // De-dupe filenames by appending "(N)"
      const nameCount: Record<string, number> = {};
      const uniqueFiles = downloads.map((f) => {
        nameCount[f.name] = (nameCount[f.name] || 0) + 1;
        if (nameCount[f.name] > 1) {
          const ext = f.name.lastIndexOf(".");
          const base = ext > 0 ? f.name.slice(0, ext) : f.name;
          const suffix = ext > 0 ? f.name.slice(ext) : "";
          return { ...f, name: `${base} (${nameCount[f.name] - 1})${suffix}` };
        }
        return f;
      });

      // Build the ZIP and trigger a browser download
      const zipData: Record<string, Uint8Array> = {};
      for (const f of uniqueFiles) zipData[f.name] = f.data;
      const zipped = zipSync(zipData);

      const blob = new Blob([zipped.buffer as ArrayBuffer], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `vault-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(`Downloaded ${uniqueFiles.length} files as ZIP`, { id: toastId });
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to create ZIP download", { id: toastId });
    } finally {
      setBulkDownloading(false);
    }
  }, [selectedFiles, downloadSingle]);

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
  };
}
