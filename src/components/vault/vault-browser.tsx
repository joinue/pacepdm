"use client";

import { useTenantUser } from "@/components/providers/tenant-provider";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useVaultBrowser } from "@/hooks/use-vault-browser";
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

  const selectedFileData = vault.files.find((f) => f.id === vault.selectedFile);
  const detailProps = vault.selectedFile ? {
    fileId: vault.selectedFile,
    metadataFields,
    onClose: () => vault.selectFile(null),
    onRefresh: () => vault.loadContents(vault.currentFolderId),
    userId: user.id,
    onCheckIn: () => vault.setCheckInFileId(vault.selectedFile!),
    onChangeState: () => { if (selectedFileData) vault.openTransitionDialog(selectedFileData.id, selectedFileData.name, selectedFileData.lifecycleId ?? null); },
    onRename: () => { if (selectedFileData) { vault.setRenameTarget({ id: selectedFileData.id, name: selectedFileData.name, type: "file" }); vault.setNewName(selectedFileData.name); } },
    onDelete: () => { if (selectedFileData) vault.setDeleteTarget({ id: selectedFileData.id, name: selectedFileData.name, type: "file" }); },
  } : null;

  return (
    <div className="space-y-4">
      <VaultToolbar vault={vault} />

      {/* Detail view — replaces file list on desktop, sheet on mobile */}
      {vault.selectedFile && detailProps && (
        isDesktop ? (
          <div className="border rounded-lg bg-background" style={{ height: "calc(100vh - 12rem)" }}>
            <FileDetailPanel {...detailProps} layout="full" />
          </div>
        ) : (
          <Sheet open={!!vault.selectedFile} onOpenChange={(open) => { if (!open) vault.selectFile(null); }}>
            <SheetContent side="right" className="w-full max-w-none! p-0" showCloseButton={false}>
              <FileDetailPanel {...detailProps} layout="compact" />
            </SheetContent>
          </Sheet>
        )
      )}

      {/* File list — hidden when detail view is open on desktop */}
      <div className={vault.selectedFile && isDesktop ? "hidden" : ""}>
        <VaultFileList vault={vault} userId={user.id} />
      </div>

      {/* Dialogs */}
      <CreateFolderDialog open={vault.showCreateFolder} onOpenChange={vault.setShowCreateFolder} parentId={vault.currentFolderId} onCreated={() => vault.loadContents(vault.currentFolderId)} />
      <UploadFileDialog open={vault.showUpload} onOpenChange={vault.setShowUpload} folderId={vault.currentFolderId} onUploaded={() => vault.loadContents(vault.currentFolderId)} />
      {vault.checkInFileId && <CheckInDialog open={!!vault.checkInFileId} onOpenChange={(open) => !open && vault.setCheckInFileId(null)} fileId={vault.checkInFileId} onCheckedIn={() => { vault.setCheckInFileId(null); vault.loadContents(vault.currentFolderId); }} />}

      <VaultDialogs vault={vault} />
    </div>
  );
}
