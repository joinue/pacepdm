"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useTenantUser } from "@/components/providers/tenant-provider";
import { useNotifications } from "@/components/providers/notification-provider";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useVaultBrowser } from "@/hooks/use-vault-browser";
import { usePermissions } from "@/hooks/use-permissions";
import { useRealtimeTable } from "@/hooks/use-realtime-table";
import { PERMISSIONS } from "@/lib/permissions";
import { errorMessage } from "@/lib/api-client";
import { readDroppedFiles, type DroppedFile } from "@/lib/dropped-files";
import { toast } from "sonner";
import { Upload } from "lucide-react";
import { CreateFolderDialog } from "./create-folder-dialog";
import { UploadFileDialog } from "./upload-file-dialog";
import { FileDetailPanel } from "./file-detail-panel";
import { CheckInDialog } from "./checkin-dialog";
import { VaultToolbar } from "./vault-toolbar";
import { VaultFileList } from "./vault-file-list";
import { TrashList } from "./trash-list";
import { VaultDialogs } from "./vault-dialogs";
import type { BreadcrumbEntry, MetadataFieldDef } from "./vault-types";

const UNSAVED_PROPERTIES_PROMPT =
  "This file has property changes that have not been saved. Leave and discard them?";

export function VaultBrowser({
  rootFolderId,
  metadataFields,
  initialBreadcrumbs = null,
}: {
  rootFolderId: string;
  metadataFields: MetadataFieldDef[];
  /**
   * The trail for the folder the URL opened on, resolved by the page. Without
   * it a deep link renders "Vault" and then the real path a round trip later.
   */
  initialBreadcrumbs?: BreadcrumbEntry[] | null;
}) {
  const user = useTenantUser();
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const vault = useVaultBrowser({
    rootFolderId,
    userId: user.id,
    userFullName: user.fullName,
    initialBreadcrumbs,
  });
  const { can } = usePermissions();
  const { clearRef } = useNotifications();

  // Unsaved property edits in the detail panel. Every navigation that would
  // close the file asks first; see `setLeaveGuard` in use-vault-navigation.
  const [panelDirty, setPanelDirty] = useState(false);
  const { setLeaveGuard } = vault;
  useEffect(() => {
    setLeaveGuard(panelDirty ? () => window.confirm(UNSAVED_PROPERTIES_PROMPT) : null);
    return () => setLeaveGuard(null);
  }, [panelDirty, setLeaveGuard]);

  // When a file is opened in the detail panel, auto-clear its unread
  // notifications — consistent with BOM and ECO detail views.
  useEffect(() => {
    if (vault.selectedFile) void clearRef(vault.selectedFile);
  }, [vault.selectedFile, clearRef]);

  // Live updates: whenever any file or folder in this tenant is touched
  // — uploaded, renamed, checked out, transitioned, deleted — refresh
  // the current folder view. Scoped by tenantId so one tenant's writes
  // don't wake another tenant's clients. The hook debounces bursts so
  // a bulk-transition storm only triggers one refetch.
  //
  // `refreshFromRemote` (not `refresh`) so this tab's own writes, which
  // already refreshed explicitly, don't trigger a second listing when
  // Postgres replays them back to us.
  useRealtimeTable({
    table: "files",
    filter: `tenantId=eq.${user.tenantId}`,
    onChange: vault.refreshFromRemote,
  });
  useRealtimeTable({
    table: "folders",
    filter: `tenantId=eq.${user.tenantId}`,
    onChange: vault.refreshFromRemote,
  });

  // External drop: files or whole folders dragged from the desktop onto the
  // vault open the upload dialog with everything that was dropped. Only the
  // first file used to be kept, and a dropped folder failed.
  const [externalDropItems, setExternalDropItems] = useState<DroppedFile[] | null>(null);
  const [showDropOverlay, setShowDropOverlay] = useState(false);
  const dragCounter = useRef(0);

  const handleExternalDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragCounter.current++;
    setShowDropOverlay(true);
  }, []);

  const handleExternalDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleExternalDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setShowDropOverlay(false);
    }
  }, []);

  const handleExternalDrop = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      dragCounter.current = 0;
      setShowDropOverlay(false);
      // Reads the entries synchronously before its first await; the
      // DataTransfer is emptied once this handler yields.
      readDroppedFiles(e.dataTransfer)
        .then((dropped) => {
          if (dropped.length === 0) return;
          setExternalDropItems(dropped);
          vault.setShowUpload(true);
        })
        .catch((err) => toast.error(errorMessage(err)));
    },
    [vault]
  );

  // Clear the external drop file when the upload dialog closes
  const handleUploadDialogChange = useCallback(
    (open: boolean) => {
      vault.setShowUpload(open);
      if (!open) setExternalDropItems(null);
    },
    [vault]
  );

  const selectedFileData = vault.files.find((f) => f.id === vault.selectedFile);

  // Pass undefined for actions the user can't perform — the detail panel
  // already hides menu items when their callbacks are missing. Server still
  // enforces permissions; this is purely UX.
  const detailProps = vault.selectedFile
    ? {
        fileId: vault.selectedFile,
        metadataFields,
        onClose: () => vault.selectFile(null),
        onRefresh: () => vault.refresh(),
        userId: user.id,
        onCheckIn: can(PERMISSIONS.FILE_CHECKIN)
          ? () => vault.setCheckInFileId(vault.selectedFile!)
          : undefined,
        onChangeState: can(PERMISSIONS.FILE_TRANSITION)
          ? () => {
              if (selectedFileData)
                vault.openTransitionDialog(
                  selectedFileData.id,
                  selectedFileData.name,
                  selectedFileData.lifecycleId ?? null
                );
            }
          : undefined,
        onRename: can(PERMISSIONS.FILE_EDIT)
          ? () => {
              if (selectedFileData) {
                vault.setRenameTarget({
                  id: selectedFileData.id,
                  name: selectedFileData.name,
                  type: "file",
                });
                vault.setNewName(selectedFileData.name);
              }
            }
          : undefined,
        onDelete: can(PERMISSIONS.FILE_DELETE)
          ? () => {
              if (selectedFileData)
                vault.setDeleteTarget({
                  id: selectedFileData.id,
                  name: selectedFileData.name,
                  type: "file",
                });
            }
          : undefined,
        isAdmin: can("admin.settings") || can("*"),
        onDirtyChange: setPanelDirty,
      }
    : null;

  return (
    <div
      className="space-y-4 relative"
      onDragEnter={handleExternalDragEnter}
      onDragOver={handleExternalDragOver}
      onDragLeave={handleExternalDragLeave}
      onDrop={handleExternalDrop}
    >
      {showDropOverlay && (
        <div className="absolute inset-0 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary/5 backdrop-blur-sm pointer-events-none">
          <div className="text-center">
            <Upload className="w-10 h-10 mx-auto text-primary mb-2" />
            <p className="text-sm font-medium text-primary">Drop file to upload</p>
          </div>
        </div>
      )}
      <VaultToolbar vault={vault} />

      {/* Detail view — replaces file list on desktop, sheet on mobile.
          Wrapped in ErrorBoundary so a panel render failure doesn't take down the vault. */}
      {vault.selectedFile &&
        detailProps &&
        (isDesktop ? (
          <div
            className="border rounded-lg bg-background"
            style={{ height: "calc(100vh - 12rem)" }}
          >
            <ErrorBoundary>
              <FileDetailPanel {...detailProps} layout="full" />
            </ErrorBoundary>
          </div>
        ) : (
          <Sheet
            open={!!vault.selectedFile}
            onOpenChange={(open) => {
              if (!open) vault.selectFile(null);
            }}
          >
            <SheetContent side="right" className="w-full max-w-none! p-0" showCloseButton={false}>
              <ErrorBoundary>
                <FileDetailPanel {...detailProps} layout="compact" />
              </ErrorBoundary>
            </SheetContent>
          </Sheet>
        ))}

      {/* File list — hidden when detail view is open on desktop. The trash
          renders its own list: deleted files have a different row shape and
          exactly one action, so they don't go through VaultFileList. */}
      <div className={vault.selectedFile && isDesktop ? "hidden" : ""}>
        {vault.viewMode === "trash" ? (
          <ErrorBoundary>
            <TrashList onRestored={vault.refresh} />
          </ErrorBoundary>
        ) : (
          <VaultFileList vault={vault} userId={user.id} />
        )}
      </div>

      {/* Dialogs */}
      <CreateFolderDialog
        open={vault.showCreateFolder}
        onOpenChange={vault.setShowCreateFolder}
        parentId={vault.currentFolderId}
        onCreated={() => vault.refresh()}
      />
      <UploadFileDialog
        open={vault.showUpload}
        onOpenChange={handleUploadDialogChange}
        folderId={vault.currentFolderId}
        onUploaded={() => vault.refresh()}
        initialItems={externalDropItems}
      />
      {vault.checkInFileId && (
        <CheckInDialog
          open={!!vault.checkInFileId}
          onOpenChange={(open) => !open && vault.setCheckInFileId(null)}
          fileId={vault.checkInFileId}
          onCheckedIn={() => {
            vault.setCheckInFileId(null);
            vault.refresh();
          }}
        />
      )}

      <VaultDialogs vault={vault} />
    </div>
  );
}
