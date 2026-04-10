"use client";

import React, { useState, useCallback } from "react";
import { toast } from "sonner";
import { fetchJson, errorMessage } from "@/lib/api-client";
import type { FileItem } from "@/components/vault/vault-types";

interface UseDragAndDropOptions {
  files: FileItem[];
  refresh: () => void;
}

/**
 * Drag-and-drop file moves. Drops onto a folder cell call the move API
 * and refresh the listing on success.
 */
export function useDragAndDrop({ files, refresh }: UseDragAndDropOptions) {
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

  const handleDrop = useCallback(async (e: React.DragEvent, folderId: string) => {
    e.preventDefault();
    setDropTargetId(null);
    setDragFileId(null);
    const fileId = e.dataTransfer.getData("text/plain");
    if (!fileId) return;
    try {
      await fetchJson(`/api/files/${fileId}/move`, {
        method: "PUT",
        body: { folderId },
      });
      const file = files.find((f) => f.id === fileId);
      toast.success(`Moved "${file?.name || "file"}" to folder`);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }, [files, refresh]);

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
