"use client";

import { useState, useCallback } from "react";
import { toast } from "sonner";
import { fetchJson, errorMessage } from "@/lib/api-client";
import type { FileItem, FolderItem, TransitionOption } from "@/components/vault/vault-types";

interface DialogTarget {
  id: string;
  name: string;
  type: "file" | "folder";
}

/** Applies a local edit and returns the rollback for the failure path. */
type Rollback = () => void;

interface UseFileActionsOptions {
  refresh: () => void;
  selectedFile: string | null;
  onSelectedFileDeleted: () => void;
  rootFolderId: string;
  /** The signed-in user, used to render an optimistic check-out locally. */
  currentUser: { id: string; fullName: string | null };
  patchFile: (fileId: string, patch: Partial<FileItem>) => Rollback;
  removeFile: (fileId: string) => Rollback;
  patchFolder: (folderId: string, patch: Partial<FolderItem>) => Rollback;
  removeFolder: (folderId: string) => Rollback;
}

/**
 * Single-file mutations and the dialog state that drives them.
 *
 * Each action follows the same shape: open dialog → user confirms → apply the
 * expected result locally → call the API → reconcile with a refresh on
 * success, roll the local edit back and surface the error on failure.
 *
 * The optimistic step matters because the alternative is two sequential
 * round-trips (the mutation, then the refetch) before the row visibly
 * changes, which is what made every vault action feel laggy.
 *
 * Dialogs (rename / delete / transition / move) live here because their state
 * is tightly coupled to the action handlers.
 */
export function useFileActions({
  refresh,
  selectedFile,
  onSelectedFileDeleted,
  rootFolderId,
  currentUser,
  patchFile,
  removeFile,
  patchFolder,
  removeFolder,
}: UseFileActionsOptions) {
  // Rename
  const [renameTarget, setRenameTarget] = useState<DialogTarget | null>(null);
  const [newName, setNewName] = useState("");

  // Delete
  const [deleteTarget, setDeleteTarget] = useState<DialogTarget | null>(null);

  // Transition
  const [transitionTarget, setTransitionTarget] = useState<{
    fileId: string;
    fileName: string;
  } | null>(null);
  const [transitions, setTransitions] = useState<TransitionOption[]>([]);

  // Move
  const [moveTarget, setMoveTarget] = useState<{ id: string; name: string } | null>(null);
  const [moveFolders, setMoveFolders] = useState<FolderItem[]>([]);
  const [moveDestination, setMoveDestination] = useState<string>("");

  const handleCheckout = useCallback(
    async (fileId: string) => {
      const rollback = patchFile(fileId, {
        isCheckedOut: true,
        checkedOutById: currentUser.id,
        checkedOutBy: { fullName: currentUser.fullName ?? "You" },
      });
      try {
        await fetchJson(`/api/files/${fileId}/checkout`, { method: "POST" });
        toast.success("File checked out");
        refresh();
      } catch (err) {
        rollback();
        toast.error(errorMessage(err));
      }
    },
    [refresh, patchFile, currentUser.id, currentUser.fullName]
  );

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
    const trimmed = newName.trim();
    const isFile = renameTarget.type === "file";
    const url = isFile ? `/api/files/${renameTarget.id}/rename` : `/api/folders/${renameTarget.id}`;

    // Close the dialog and show the new name before the request resolves —
    // the rollback restores both if the server rejects it.
    const rollback = isFile
      ? patchFile(renameTarget.id, { name: trimmed })
      : patchFolder(renameTarget.id, { name: trimmed });
    setRenameTarget(null);

    try {
      await fetchJson(url, { method: "PUT", body: { name: trimmed } });
      toast.success(`${isFile ? "File" : "Folder"} renamed`);
      refresh();
    } catch (err) {
      rollback();
      toast.error(errorMessage(err));
    }
  }, [renameTarget, newName, refresh, patchFile, patchFolder]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const isFile = deleteTarget.type === "file";
    const url = isFile ? `/api/files/${deleteTarget.id}/delete` : `/api/folders/${deleteTarget.id}`;
    const wasSelected = isFile && selectedFile === deleteTarget.id;

    const rollback = isFile ? removeFile(deleteTarget.id) : removeFolder(deleteTarget.id);
    setDeleteTarget(null);
    if (wasSelected) onSelectedFileDeleted();

    try {
      await fetchJson(url, { method: "DELETE" });
      toast.success(`${isFile ? "File" : "Folder"} deleted`);
      refresh();
    } catch (err) {
      rollback();
      toast.error(errorMessage(err));
    }
  }, [deleteTarget, selectedFile, onSelectedFileDeleted, refresh, removeFile, removeFolder]);

  const handleTransition = useCallback(
    async (transitionId: string) => {
      if (!transitionTarget) return;
      const { fileId } = transitionTarget;

      // The chosen transition already tells us the destination state, so the
      // row can show it immediately. If the server comes back with
      // `pendingApproval` the state did *not* change, and we swap the
      // optimistic state for a PENDING badge instead.
      const target = transitions.find((t) => t.id === transitionId);
      const rollback = target
        ? patchFile(fileId, { lifecycleState: target.toState.name })
        : () => {};
      setTransitionTarget(null);

      try {
        // Two possible response shapes: an immediate state change
        // ({ newState }) or a gated approval request ({ pendingApproval }).
        // Pick the toast accordingly so we never render "undefined".
        const d = await fetchJson<{
          newState?: string;
          pendingApproval?: boolean;
          message?: string;
        }>(`/api/files/${fileId}/transition`, {
          method: "POST",
          body: { transitionId },
        });
        if (d.pendingApproval) {
          rollback();
          patchFile(fileId, { approvalStatus: "PENDING" });
          toast.success(d.message || "Approval requested — waiting for reviewers");
        } else if (d.newState) {
          toast.success(`State changed to ${d.newState}`);
        } else {
          toast.success("Transition submitted");
        }
        refresh();
      } catch (err) {
        rollback();
        toast.error(errorMessage(err));
      }
    },
    [transitionTarget, transitions, refresh, patchFile]
  );

  const openTransitionDialog = useCallback(
    async (fileId: string, fileName: string, lifecycleId: string | null) => {
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
    },
    []
  );

  const openMoveDialog = useCallback(
    async (fileId: string, fileName: string) => {
      try {
        const data = await fetchJson<FolderItem[]>(`/api/folders?parentId=${rootFolderId}`);
        setMoveFolders(Array.isArray(data) ? data : []);
        setMoveTarget({ id: fileId, name: fileName });
        setMoveDestination("");
      } catch (err) {
        toast.error(errorMessage(err) || "Failed to load folders");
      }
    },
    [rootFolderId]
  );

  const handleMove = useCallback(async () => {
    if (!moveTarget || !moveDestination) return;
    const { id } = moveTarget;

    // The file is leaving the folder we're looking at, so drop it from the
    // list rather than patching it.
    const rollback = removeFile(id);
    setMoveTarget(null);

    try {
      await fetchJson(`/api/files/${id}/move`, {
        method: "PUT",
        body: { folderId: moveDestination },
      });
      toast.success("File moved");
      refresh();
    } catch (err) {
      rollback();
      toast.error(errorMessage(err));
    }
  }, [moveTarget, moveDestination, refresh, removeFile]);

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
