"use client";

import { useState, useCallback, useMemo } from "react";

/**
 * Multi-file selection state for bulk actions.
 *
 * The `effectiveSelected` set is derived from the raw `selectedFiles` state
 * intersected with the current `filteredFileIds`. This prunes any stale IDs
 * automatically when the folder changes or when filters narrow the file
 * list — no `useEffect`-based reset needed.
 */
export function useVaultSelection(filteredFileIds: string[]) {
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());

  // Derived: only IDs that are still present in the visible file list
  const effectiveSelected = useMemo(() => {
    if (selectedFiles.size === 0) return selectedFiles;
    const visible = new Set(filteredFileIds);
    const next = new Set<string>();
    for (const id of selectedFiles) if (visible.has(id)) next.add(id);
    return next;
  }, [selectedFiles, filteredFileIds]);

  const toggleFileSelect = useCallback((fileId: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedFiles((prev) =>
      prev.size === filteredFileIds.length ? new Set() : new Set(filteredFileIds)
    );
  }, [filteredFileIds]);

  return {
    selectedFiles: effectiveSelected,
    setSelectedFiles,
    toggleFileSelect,
    toggleSelectAll,
  };
}
