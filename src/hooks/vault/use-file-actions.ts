"use client";

import { useState, useCallback } from "react";
import { toast } from "sonner";
import { fetchJson, errorMessage } from "@/lib/api-client";
import type { FolderItem, TransitionOption } from "@/components/vault/vault-types";

interface DialogTarget {
  id: string;
  name: string;
  type: "file" | "folder";
}

interface UseFileActionsOptions {
  refresh: () => void;
  selectedFile: string | null;
  onSelectedFileDeleted: () => void;
  rootFolderId: string;
}

/**
 * Single-file mutations and the dialog state that drives them.
 *
 * Each action follows the same shape: open dialog → user confirms →
 * call API via fetchJson → refresh list on success, surface error on failure.
 *
 * Dialogs (rename / delete / transition / move) live here because their state
 * is tightly coupled to the action handlers.
 */
export function useFileActions({
  refresh,
  selectedFile,
  onSelectedFileDeleted,
  rootFolderId,
}: UseFileActionsOptions) {
  // Rename
  const [renameTarget, setRenameTarget] = useState<DialogTarget | null>(null);
  const [newName, setNewName] = useState("");

  // Delete
  const [deleteTarget, setDeleteTarget] = useState<DialogTarget | null>(null);

  // Transition
  const [transitionTarget, setTransitionTarget] = useState<{ fileId: string; fileName: string } | null>(null);
  const [transitions, setTransitions] = useState<TransitionOption[]>([]);

  // Move
  const [moveTarget, setMoveTarget] = useState<{ id: string; name: string } | null>(null);
  const [moveFolders, setMoveFolders] = useState<FolderItem[]>([]);
  const [moveDestination, setMoveDestination] = useState<string>("");

  const handleCheckout = useCallback(async (fileId: string) => {
    try {
      await fetchJson(`/api/files/${fileId}/checkout`, { method: "POST" });
      toast.success("File checked out");
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }, [refresh]);

  const handleDownload = useCallback(async (fileId: string) => {
    try {
      const d = await fetchJson<{ url?: string }>(`/api/files/${fileId}/download`);
      if (d.url) window.open(d.url, "_blank");
      else toast.error("Failed to download — no URL returned");
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to download");
    }
  }, []);

  const handleRename = useCallback(async () => {
    if (!renameTarget || !newName.trim()) return;
    const url = renameTarget.type === "file"
      ? `/api/files/${renameTarget.id}/rename`
      : `/api/folders/${renameTarget.id}`;
    try {
      await fetchJson(url, { method: "PUT", body: { name: newName.trim() } });
      toast.success(`${renameTarget.type === "file" ? "File" : "Folder"} renamed`);
      setRenameTarget(null);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }, [renameTarget, newName, refresh]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const url = deleteTarget.type === "file"
      ? `/api/files/${deleteTarget.id}/delete`
      : `/api/folders/${deleteTarget.id}`;
    try {
      await fetchJson(url, { method: "DELETE" });
      toast.success(`${deleteTarget.type === "file" ? "File" : "Folder"} deleted`);
      const wasSelected = deleteTarget.type === "file" && selectedFile === deleteTarget.id;
      setDeleteTarget(null);
      if (wasSelected) onSelectedFileDeleted();
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }, [deleteTarget, selectedFile, onSelectedFileDeleted, refresh]);

  const handleTransition = useCallback(async (transitionId: string) => {
    if (!transitionTarget) return;
    try {
      // Two possible response shapes: an immediate state change
      // ({ newState }) or a gated approval request ({ pendingApproval }).
      // Pick the toast accordingly so we never render "undefined".
      const d = await fetchJson<{
        newState?: string;
        pendingApproval?: boolean;
        message?: string;
      }>(
        `/api/files/${transitionTarget.fileId}/transition`,
        { method: "POST", body: { transitionId } }
      );
      if (d.pendingApproval) {
        toast.success(d.message || "Approval requested — waiting for reviewers");
      } else if (d.newState) {
        toast.success(`State changed to ${d.newState}`);
      } else {
        toast.success("Transition submitted");
      }
      setTransitionTarget(null);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }, [transitionTarget, refresh]);

  const openTransitionDialog = useCallback(async (
    fileId: string,
    fileName: string,
    lifecycleId: string | null
  ) => {
    if (!lifecycleId) {
      toast.error("No lifecycle assigned");
      return;
    }
    try {
      const file = await fetchJson<{ lifecycleState: string }>(`/api/files/${fileId}`);
      const data = await fetchJson<TransitionOption[]>(
        `/api/lifecycle/${lifecycleId}/transitions?fromState=${file.lifecycleState}`
      );
      setTransitions(Array.isArray(data) ? data : []);
      setTransitionTarget({ fileId, fileName });
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to load transitions");
    }
  }, []);

  const openMoveDialog = useCallback(async (fileId: string, fileName: string) => {
    try {
      const data = await fetchJson<FolderItem[]>(`/api/folders?parentId=${rootFolderId}`);
      setMoveFolders(Array.isArray(data) ? data : []);
      setMoveTarget({ id: fileId, name: fileName });
      setMoveDestination("");
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to load folders");
    }
  }, [rootFolderId]);

  const handleMove = useCallback(async () => {
    if (!moveTarget || !moveDestination) return;
    try {
      await fetchJson(`/api/files/${moveTarget.id}/move`, {
        method: "PUT",
        body: { folderId: moveDestination },
      });
      toast.success("File moved");
      setMoveTarget(null);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }, [moveTarget, moveDestination, refresh]);

  return {
    // Rename
    renameTarget,
    setRenameTarget,
    newName,
    setNewName,
    handleRename,

    // Delete
    deleteTarget,
    setDeleteTarget,
    handleDelete,

    // Transition
    transitionTarget,
    setTransitionTarget,
    transitions,
    handleTransition,
    openTransitionDialog,

    // Move
    moveTarget,
    setMoveTarget,
    moveFolders,
    moveDestination,
    setMoveDestination,
    handleMove,
    openMoveDialog,

    // Direct actions
    handleCheckout,
    handleDownload,
  };
}

export type FileActions = ReturnType<typeof useFileActions>;
