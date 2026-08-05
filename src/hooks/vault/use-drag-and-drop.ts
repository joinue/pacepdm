"use client";

import React, { useState, useCallback } from "react";
import { toast } from "sonner";
import { fetchJson, errorMessage } from "@/lib/api-client";
import type { FileItem } from "@/components/vault/vault-types";

interface UseDragAndDropOptions {
  files: FileItem[];
  refresh: () => void;
  /** Drops the row locally and returns the rollback for a failed move. */
  removeFile: (fileId: string) => () => void;
}

/**
 * Drag-and-drop file moves. Drops onto a folder cell remove the row from the
 * current listing straight away, call the move API, and put it back if the
 * move is rejected — a drag that visibly does nothing until the server
 * answers reads as a dropped drag.
 */
export function useDragAndDrop({ files, refresh, removeFile }: UseDragAndDropOptions) {
  const [dragFileId, setDragFileId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const handleDragStart = useCallback((e: React.DragEvent, fileId: string) => {
    e.dataTransfer.setData("text/plain", fileId);
    e.dataTransfer.effectAllowed = "move";
    setDragFileId(fileId);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDragFileId(null);
    setDropTargetId(null);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, folderId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTargetId(folderId);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDropTargetId(null);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent, folderId: string) => {
      e.preventDefault();
      setDropTargetId(null);
      setDragFileId(null);
      const fileId = e.dataTransfer.getData("text/plain");
      if (!fileId) return;

      // Read the name before the row leaves the list.
      const file = files.find((f) => f.id === fileId);
      const rollback = removeFile(fileId);

      try {
        await fetchJson(`/api/files/${fileId}/move`, {
          method: "PUT",
          body: { folderId },
        });
        toast.success(`Moved "${file?.name || "file"}" to folder`);
        refresh();
      } catch (err) {
        rollback();
        toast.error(errorMessage(err));
      }
    },
    [files, refresh, removeFile]
  );

  return {
    dragFileId,
    dropTargetId,
    handleDragStart,
    handleDragEnd,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}
