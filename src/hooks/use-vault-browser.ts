"use client";

import { useState, useEffect, useCallback } from "react";
import { useVaultNavigation } from "@/hooks/vault/use-vault-navigation";
import { useVaultContents } from "@/hooks/vault/use-vault-contents";
import { useVaultSelection } from "@/hooks/vault/use-vault-selection";
import { useVaultFilter } from "@/hooks/vault/use-vault-filter";
import { useFileActions } from "@/hooks/vault/use-file-actions";
import { useBulkActions } from "@/hooks/vault/use-bulk-actions";
import { useDragAndDrop } from "@/hooks/vault/use-drag-and-drop";
import { useRealtimeEchoGuard } from "@/hooks/use-realtime-echo-guard";

interface UseVaultBrowserOptions {
  rootFolderId: string;
  userId: string;
  /** Display name for the optimistic "checked out by" label. */
  userFullName: string | null;
}

/**
 * Composition root for the vault browser.
 *
 * This is a thin facade that wires together the smaller, focused hooks
 * (navigation, contents, selection, filter, file actions, bulk actions,
 * drag-and-drop) into a single returned object so consumers don't need
 * to manage seven hooks themselves.
 *
 * The previous version was a 450-line monolithic hook with 50+ exposed
 * properties. Each concern now lives in its own file under `src/hooks/vault/`
 * and can be tested in isolation.
 */
export function useVaultBrowser({ rootFolderId, userId, userFullName }: UseVaultBrowserOptions) {
  // Top-level dialog visibility — these belong to the page, not to any
  // single sub-hook, so they live here.
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [checkInFileId, setCheckInFileId] = useState<string | null>(null);

  // Navigation: current folder, breadcrumbs, selected file, view mode, URL sync
  const navigation = useVaultNavigation(rootFolderId);

  // Contents: load folders + files for the current view (folder or flat).
  // The hook owns the "reload on source change" effect internally, so the
  // composition root only needs to forward the inputs.
  const contents = useVaultContents(navigation.viewMode, navigation.currentFolderId);

  // Search/filter, derived from contents
  const filter = useVaultFilter(contents.files);

  // Multi-select for bulk actions; selections that aren't visible are
  // pruned automatically (e.g., when the view changes or filters narrow).
  const selection = useVaultSelection(filter.filteredFiles.map((f) => f.id));

  // Realtime on `files`/`folders` replays this tab's own writes back to it.
  // Marking each local mutation lets the realtime handler skip the echo, so
  // one user action costs one listing instead of two.
  const echoGuard = useRealtimeEchoGuard();

  // Refresh helper used by every mutation hook. `contents.refresh` already
  // knows which source (folder or flat) is active and re-fetches it, so
  // callers don't need to branch on viewMode themselves.
  const contentsRefresh = contents.refresh;
  const { markLocalWrite, isEcho } = echoGuard;

  const refresh = useCallback(() => {
    markLocalWrite();
    return contentsRefresh();
  }, [markLocalWrite, contentsRefresh]);

  // What the realtime subscriptions call. Skips the refetch when the event is
  // this tab's own write coming back around.
  const refreshFromRemote = useCallback(() => {
    if (isEcho()) return;
    void contentsRefresh();
  }, [isEcho, contentsRefresh]);

  // Single-file mutations (rename, delete, transition, move) + their dialogs
  const fileActions = useFileActions({
    refresh,
    selectedFile: navigation.selectedFile,
    onSelectedFileDeleted: () => navigation.selectFile(null),
    rootFolderId,
    currentUser: { id: userId, fullName: userFullName },
    patchFile: contents.patchFile,
    removeFile: contents.removeFile,
    patchFolder: contents.patchFolder,
    removeFolder: contents.removeFolder,
  });

  // Bulk delete + zip download (selections and current folder)
  const bulkActions = useBulkActions({
    selectedFiles: selection.selectedFiles,
    clearSelection: () => selection.setSelectedFiles(new Set()),
    refresh,
    downloadSingle: fileActions.handleDownload,
    currentFolderId: navigation.currentFolderId,
    rootFolderId,
    removeFile: contents.removeFile,
  });

  // Drag-and-drop file moves
  const dnd = useDragAndDrop({
    files: contents.files,
    refresh,
    removeFile: contents.removeFile,
  });

  // Hydrate breadcrumbs once on mount for deep links
  useEffect(() => {
    return navigation.hydrateBreadcrumbsFromDeepLink();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Return a flat object with the same shape the previous monolithic hook
  // exposed, so existing components don't need to change.
  return {
    // Navigation
    viewMode: navigation.viewMode,
    currentFolderId: navigation.currentFolderId,
    breadcrumbs: navigation.breadcrumbs,
    selectedFile: navigation.selectedFile,
    selectFile: navigation.selectFile,
    navigateToFolder: navigation.navigateToFolder,
    navigateToBreadcrumb: navigation.navigateToBreadcrumb,
    enterFlatView: navigation.enterFlatView,
    exitFlatView: navigation.exitFlatView,

    // Contents
    folders: contents.folders,
    files: contents.files,
    loading: contents.loading,
    refresh,
    refreshFromRemote,

    // Filter
    searchQuery: filter.searchQuery,
    setSearchQuery: filter.setSearchQuery,
    filterState: filter.filterState,
    setFilterState: filter.setFilterState,
    filteredFiles: filter.filteredFiles,
    lifecycleStates: filter.lifecycleStates,

    // Selection
    selectedFiles: selection.selectedFiles,
    toggleFileSelect: selection.toggleFileSelect,
    toggleSelectAll: selection.toggleSelectAll,

    // Top-level dialogs
    showCreateFolder,
    setShowCreateFolder,
    showUpload,
    setShowUpload,
    checkInFileId,
    setCheckInFileId,

    // Single-file actions
    handleCheckout: fileActions.handleCheckout,
    handleDownload: fileActions.handleDownload,
    renameTarget: fileActions.renameTarget,
    setRenameTarget: fileActions.setRenameTarget,
    newName: fileActions.newName,
    setNewName: fileActions.setNewName,
    handleRename: fileActions.handleRename,
    deleteTarget: fileActions.deleteTarget,
    setDeleteTarget: fileActions.setDeleteTarget,
    handleDelete: fileActions.handleDelete,
    transitionTarget: fileActions.transitionTarget,
    setTransitionTarget: fileActions.setTransitionTarget,
    transitions: fileActions.transitions,
    handleTransition: fileActions.handleTransition,
    openTransitionDialog: fileActions.openTransitionDialog,
    moveTarget: fileActions.moveTarget,
    setMoveTarget: fileActions.setMoveTarget,
    moveFolders: fileActions.moveFolders,
    moveDestination: fileActions.moveDestination,
    setMoveDestination: fileActions.setMoveDestination,
    handleMove: fileActions.handleMove,
    openMoveDialog: fileActions.openMoveDialog,

    // Bulk actions
    showBulkDeleteConfirm: bulkActions.showBulkDeleteConfirm,
    setShowBulkDeleteConfirm: bulkActions.setShowBulkDeleteConfirm,
    bulkDownloading: bulkActions.bulkDownloading,
    handleBulkDownload: bulkActions.handleBulkDownload,
    handleBulkDelete: bulkActions.handleBulkDelete,
    canDownloadFolder: bulkActions.canDownloadFolder,
    folderDownloading: bulkActions.folderDownloading,
    handleFolderDownload: bulkActions.handleFolderDownload,

    // Drag-and-drop
    dragFileId: dnd.dragFileId,
    dropTargetId: dnd.dropTargetId,
    handleDragStart: dnd.handleDragStart,
    handleDragEnd: dnd.handleDragEnd,
    handleDragOver: dnd.handleDragOver,
    handleDragLeave: dnd.handleDragLeave,
    handleDrop: dnd.handleDrop,
  };
}

export type VaultBrowserState = ReturnType<typeof useVaultBrowser>;
