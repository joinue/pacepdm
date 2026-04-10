"use client";

import { useState, useMemo } from "react";
import type { FileItem } from "@/components/vault/vault-types";

/**
 * Client-side search and lifecycle-state filter for the file list.
 *
 * Memoizes both the filtered file list and the unique-states list so
 * downstream components don't re-render on unrelated changes.
 */
export function useVaultFilter(files: FileItem[]) {
  const [searchQuery, setSearchQuery] = useState("");
  const [filterState, setFilterState] = useState<string>("all");

  const filteredFiles = useMemo(() => {
    return files.filter((f) => {
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (
          !f.name.toLowerCase().includes(q) &&
          !(f.partNumber || "").toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      if (filterState !== "all" && f.lifecycleState !== filterState) return false;
      return true;
    });
  }, [files, searchQuery, filterState]);

  const lifecycleStates = useMemo(
    () => [...new Set(files.map((f) => f.lifecycleState))],
    [files]
  );

  return {
    searchQuery,
    setSearchQuery,
    filterState,
    setFilterState,
    filteredFiles,
    lifecycleStates,
  };
}
