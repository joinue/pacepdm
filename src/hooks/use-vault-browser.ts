"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { zipSync } from "fflate";
import type {
  FolderItem,
  FileItem,
  BreadcrumbEntry,
  TransitionOption,
} from "@/components/vault/vault-types";

interface UseVaultBrowserOptions {
  rootFolderId: string;
  userId: string;
}

export function useVaultBrowser({ rootFolderId, userId }: UseVaultBrowserOptions) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [currentFolderId, setCurrentFolderId] = useState(
    searchParams.get("folderId") || rootFolderId
  );
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbEntry[]>([
    { id: rootFolderId, name: "Vault" },
  ]);
  const [loading, setLoading] = useState(true);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(
    searchParams.get("fileId") || null
  );
  const [checkInFileId, setCheckInFileId] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());

  // Rename state
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string; type: "file" | "folder" } | null>(null);
  const [newName, setNewName] = useState("");

  // Delete state
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string; type: "file" | "folder" } | null>(null);

  // Transition state
  const [transitionTarget, setTransitionTarget] = useState<{ fileId: string; fileName: string } | null>(null);
  const [transitions, setTransitions] = useState<TransitionOption[]>([]);

  // Move state
  const [moveTarget, setMoveTarget] = useState<{ id: string; name: string } | null>(null);
  const [moveFolders, setMoveFolders] = useState<FolderItem[]>([]);
  const [moveDestination, setMoveDestination] = useState<string>("");

  // Search/filter
  const [searchQuery, setSearchQuery] = useState("");
  const [filterState, setFilterState] = useState<string>("all");

  // Bulk delete confirm
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);

  // Drag and drop
  const [dragFileId, setDragFileId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const loadContents = useCallback(async (folderId: string) => {
    setLoading(true);
    try {
      const [foldersRes, filesRes] = await Promise.all([
        fetch(`/api/folders?parentId=${folderId}`),
        fetch(`/api/files?folderId=${folderId}`),
      ]);
      const foldersData = await foldersRes.json();
      const filesData = await filesRes.json();
      setFolders(Array.isArray(foldersData) ? foldersData : []);
      setFiles(Array.isArray(filesData) ? filesData : []);
      setSelectedFiles(new Set());
    } catch {
      toast.error("Failed to load vault contents");
    }
    setLoading(false);
  }, []);

  const updateUrl = useCallback(
    (folderId: string, fileId: string | null) => {
      const params = new URLSearchParams();
      if (folderId !== rootFolderId) params.set("folderId", folderId);
      if (fileId) params.set("fileId", fileId);
      const qs = params.toString();
      router.replace(`/vault${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [rootFolderId, router]
  );

  useEffect(() => {
    loadContents(currentFolderId);
  }, [currentFolderId, loadContents]);

  // On mount: if deep-linked to a subfolder, fetch ancestor breadcrumbs
  useEffect(() => {
    const paramFolderId = searchParams.get("folderId");
    if (paramFolderId && paramFolderId !== rootFolderId) {
      fetch(`/api/folders/${paramFolderId}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.ancestors) {
            setBreadcrumbs(data.ancestors);
          }
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function navigateToFolder(folder: FolderItem) {
    setCurrentFolderId(folder.id);
    setBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
    setSelectedFile(null);
    updateUrl(folder.id, null);
  }

  function navigateToBreadcrumb(index: number) {
    const entry = breadcrumbs[index];
    setCurrentFolderId(entry.id);
    setBreadcrumbs(breadcrumbs.slice(0, index + 1));
    setSelectedFile(null);
    updateUrl(entry.id, null);
  }

  function selectFile(fileId: string | null) {
    setSelectedFile(fileId);
    updateUrl(currentFolderId, fileId);
  }

  async function handleCheckout(fileId: string) {
    const res = await fetch(`/api/files/${fileId}/checkout`, { method: "POST" });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success("File checked out");
    loadContents(currentFolderId);
  }

  async function handleDownload(fileId: string) {
    const res = await fetch(`/api/files/${fileId}/download`);
    const d = await res.json();
    if (d.url) window.open(d.url, "_blank");
    else toast.error(d.error || "Failed to download");
  }

  async function handleRename() {
    if (!renameTarget || !newName.trim()) return;
    const url = renameTarget.type === "file"
      ? `/api/files/${renameTarget.id}/rename`
      : `/api/folders/${renameTarget.id}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim() }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success(`${renameTarget.type === "file" ? "File" : "Folder"} renamed`);
    setRenameTarget(null);
    loadContents(currentFolderId);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    const url = deleteTarget.type === "file"
      ? `/api/files/${deleteTarget.id}/delete`
      : `/api/folders/${deleteTarget.id}`;
    const res = await fetch(url, { method: "DELETE" });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success(`${deleteTarget.type === "file" ? "File" : "Folder"} deleted`);
    setDeleteTarget(null);
    if (deleteTarget.type === "file" && selectedFile === deleteTarget.id) selectFile(null);
    loadContents(currentFolderId);
  }

  async function handleTransition(transitionId: string) {
    if (!transitionTarget) return;
    const res = await fetch(`/api/files/${transitionTarget.fileId}/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transitionId }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    const d = await res.json();
    toast.success(`State changed to ${d.newState}`);
    setTransitionTarget(null);
    loadContents(currentFolderId);
  }

  async function openTransitionDialog(fileId: string, fileName: string, lifecycleId: string | null) {
    if (!lifecycleId) { toast.error("No lifecycle assigned"); return; }
    const res = await fetch(`/api/files/${fileId}`);
    const file = await res.json();
    const db = await fetch(`/api/lifecycle/${lifecycleId}/transitions?fromState=${file.lifecycleState}`);
    const data = await db.json();
    setTransitions(Array.isArray(data) ? data : []);
    setTransitionTarget({ fileId, fileName });
  }

  const [bulkDownloading, setBulkDownloading] = useState(false);

  async function handleBulkDownload() {
    if (selectedFiles.size === 0) return;

    // Single file — just download directly
    if (selectedFiles.size === 1) {
      await handleDownload([...selectedFiles][0]);
      return;
    }

    setBulkDownloading(true);
    const toastId = toast.loading(`Preparing ${selectedFiles.size} files for download...`);
    try {
      // Get signed URLs for all selected files
      const res = await fetch("/api/files/bulk-download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileIds: [...selectedFiles] }),
      });
      if (!res.ok) {
        const d = await res.json();
        toast.error(d.error || "Failed to prepare download", { id: toastId });
        setBulkDownloading(false);
        return;
      }
      const { files: fileUrls } = await res.json() as { files: { name: string; url: string }[] };

      // Download all files as ArrayBuffers
      const downloads = await Promise.all(
        fileUrls.map(async (f) => {
          const resp = await fetch(f.url);
          const buffer = await resp.arrayBuffer();
          return { name: f.name, data: new Uint8Array(buffer) };
        })
      );

      // Handle duplicate filenames by appending suffix
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

      // Build ZIP
      const zipData: Record<string, Uint8Array> = {};
      for (const f of uniqueFiles) {
        zipData[f.name] = f.data;
      }
      const zipped = zipSync(zipData);

      // Trigger browser download
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
    } catch {
      toast.error("Failed to create ZIP download", { id: toastId });
    }
    setBulkDownloading(false);
  }

  async function handleBulkDelete() {
    for (const fid of selectedFiles) {
      await fetch(`/api/files/${fid}/delete`, { method: "DELETE" });
    }
    toast.success(`${selectedFiles.size} file(s) deleted`);
    setSelectedFiles(new Set());
    setShowBulkDeleteConfirm(false);
    loadContents(currentFolderId);
  }

  async function openMoveDialog(fileId: string, fileName: string) {
    const res = await fetch(`/api/folders?parentId=${rootFolderId}`);
    const data = await res.json();
    setMoveFolders(Array.isArray(data) ? data : []);
    setMoveTarget({ id: fileId, name: fileName });
    setMoveDestination("");
  }

  async function handleMove() {
    if (!moveTarget || !moveDestination) return;
    const res = await fetch(`/api/files/${moveTarget.id}/move`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderId: moveDestination }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success("File moved");
    setMoveTarget(null);
    loadContents(currentFolderId);
  }

  function handleDragStart(e: React.DragEvent, fileId: string) {
    e.dataTransfer.setData("text/plain", fileId);
    e.dataTransfer.effectAllowed = "move";
    setDragFileId(fileId);
  }

  function handleDragEnd() {
    setDragFileId(null);
    setDropTargetId(null);
  }

  function handleDragOver(e: React.DragEvent, folderId: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTargetId(folderId);
  }

  function handleDragLeave() {
    setDropTargetId(null);
  }

  async function handleDrop(e: React.DragEvent, folderId: string) {
    e.preventDefault();
    setDropTargetId(null);
    setDragFileId(null);
    const fileId = e.dataTransfer.getData("text/plain");
    if (!fileId) return;
    const res = await fetch(`/api/files/${fileId}/move`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderId }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    const file = files.find((f) => f.id === fileId);
    toast.success(`Moved "${file?.name || "file"}" to folder`);
    loadContents(currentFolderId);
  }

  function toggleFileSelect(fileId: string) {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }

  // Filter files based on search and state filter
  const filteredFiles = files.filter((f) => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      if (!f.name.toLowerCase().includes(q) && !(f.partNumber || "").toLowerCase().includes(q)) return false;
    }
    if (filterState !== "all" && f.lifecycleState !== filterState) return false;
    return true;
  });

  function toggleSelectAll() {
    if (selectedFiles.size === filteredFiles.length) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(filteredFiles.map((f) => f.id)));
    }
  }

  // Collect unique lifecycle states for filter dropdown
  const lifecycleStates = [...new Set(files.map((f) => f.lifecycleState))];

  return {
    // Core state
    currentFolderId,
    folders,
    files,
    filteredFiles,
    breadcrumbs,
    loading,
    selectedFile,
    selectedFiles,
    lifecycleStates,

    // Dialog visibility
    showCreateFolder,
    setShowCreateFolder,
    showUpload,
    setShowUpload,
    checkInFileId,
    setCheckInFileId,
    showBulkDeleteConfirm,
    setShowBulkDeleteConfirm,

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

    // Search/filter
    searchQuery,
    setSearchQuery,
    filterState,
    setFilterState,

    // Drag and drop
    dragFileId,
    dropTargetId,
    handleDragStart,
    handleDragEnd,
    handleDragOver,
    handleDragLeave,
    handleDrop,

    // Actions
    navigateToFolder,
    navigateToBreadcrumb,
    selectFile,
    handleCheckout,
    handleDownload,
    bulkDownloading,
    handleBulkDownload,
    handleBulkDelete,
    toggleFileSelect,
    toggleSelectAll,
    loadContents,
  };
}

export type VaultBrowserState = ReturnType<typeof useVaultBrowser>;
