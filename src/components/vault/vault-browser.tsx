"use client";

import { useEffect } from "react";
import { useTenantUser } from "@/components/providers/tenant-provider";
import { useNotifications } from "@/components/providers/notification-provider";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useVaultBrowser } from "@/hooks/use-vault-browser";
import { usePermissions } from "@/hooks/use-permissions";
import { useRealtimeTable } from "@/hooks/use-realtime-table";
import { PERMISSIONS } from "@/lib/permissions";
import { CreateFolderDialog } from "./create-folder-dialog";
import { UploadFileDialog } from "./upload-file-dialog";
import { FileDetailPanel } from "./file-detail-panel";
import { CheckInDialog } from "./checkin-dialog";
import { VaultToolbar } from "./vault-toolbar";
import { VaultFileList } from "./vault-file-list";
import { VaultDialogs } from "./vault-dialogs";
import type { MetadataFieldDef } from "./vault-types";

export function VaultBrowser({
  rootFolderId,
  metadataFields,
}: {
  rootFolderId: string;
  metadataFields: MetadataFieldDef[];
}) {
  const user = useTenantUser();
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const vault = useVaultBrowser({ rootFolderId, userId: user.id });
  const { can } = usePermissions();
  const { clearRef } = useNotifications();

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
  useRealtimeTable({
    table: "files",
    filter: `tenantId=eq.${user.tenantId}`,
    onChange: vault.refresh,
  });
  useRealtimeTable({
    table: "folders",
    filter: `tenantId=eq.${user.tenantId}`,
    onChange: vault.refresh,
  });

  const selectedFileData = vault.files.find((f) => f.id === vault.selectedFile);

  // Pass undefined for actions the user can't perform — the detail panel
  // already hides menu items when their callbacks are missing. Server still
  // enforces permissions; this is purely UX.
  const detailProps = vault.selectedFile ? {
    fileId: vault.selectedFile,
    metadataFields,
    onClose: () => vault.selectFile(null),
    onRefresh: () => vault.refresh(),
    userId: user.id,
    onCheckIn: can(PERMISSIONS.FILE_CHECKIN)
      ? () => vault.setCheckInFileId(vault.selectedFile!)
      : undefined,
    onChangeState: can(PERMISSIONS.FILE_TRANSITION)
      ? () => { if (selectedFileData) vault.openTransitionDialog(selectedFileData.id, selectedFileData.name, selectedFileData.lifecycleId ?? null); }
      : undefined,
    onRename: can(PERMISSIONS.FILE_EDIT)
      ? () => { if (selectedFileData) { vault.setRenameTarget({ id: selectedFileData.id, name: selectedFileData.name, type: "file" }); vault.setNewName(selectedFileData.name); } }
      : undefined,
    onDelete: can(PERMISSIONS.FILE_DELETE)
      ? () => { if (selectedFileData) vault.setDeleteTarget({ id: selectedFileData.id, name: selectedFileData.name, type: "file" }); }
      : undefined,
    isAdmin: can("admin.settings") || can("*"),
  } : null;

  return (
    <div className="space-y-4">
      <VaultToolbar vault={vault} />

      {/* Detail view — replaces file list on desktop, sheet on mobile.
          Wrapped in ErrorBoundary so a panel render failure doesn't take down the vault. */}
      {vault.selectedFile && detailProps && (
        isDesktop ? (
          <div className="border rounded-lg bg-background" style={{ height: "calc(100vh - 12rem)" }}>
            <ErrorBoundary>
              <FileDetailPanel {...detailProps} layout="full" />
            </ErrorBoundary>
          </div>
        ) : (
          <Sheet open={!!vault.selectedFile} onOpenChange={(open) => { if (!open) vault.selectFile(null); }}>
            <SheetContent side="right" className="w-full max-w-none! p-0" showCloseButton={false}>
              <ErrorBoundary>
                <FileDetailPanel {...detailProps} layout="compact" />
              </ErrorBoundary>
            </SheetContent>
          </Sheet>
        )
      )}

      {/* File list — hidden when detail view is open on desktop */}
      <div className={vault.selectedFile && isDesktop ? "hidden" : ""}>
        <VaultFileList vault={vault} userId={user.id} />
      </div>

      {/* Dialogs */}
      <CreateFolderDialog open={vault.showCreateFolder} onOpenChange={vault.setShowCreateFolder} parentId={vault.currentFolderId} onCreated={() => vault.refresh()} />
      <UploadFileDialog open={vault.showUpload} onOpenChange={vault.setShowUpload} folderId={vault.currentFolderId} onUploaded={() => vault.refresh()} />
      {vault.checkInFileId && <CheckInDialog open={!!vault.checkInFileId} onOpenChange={(open) => !open && vault.setCheckInFileId(null)} fileId={vault.checkInFileId} onCheckedIn={() => { vault.setCheckInFileId(null); vault.refresh(); }} />}

      <VaultDialogs vault={vault} />
    </div>
  );
}
