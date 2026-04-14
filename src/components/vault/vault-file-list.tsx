"use client";

import React, { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FormattedDate } from "@/components/ui/formatted-date";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  FolderOpen, MoreHorizontal, Download, LogIn, LogOut, Eye,
  File as FileIcon, FileText, Pencil, Trash2, FolderInput,
  ArrowRightLeft, Lock, Clock, XCircle, Shield, ImagePlus, Loader2, ArrowUp,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { VaultBrowserState } from "@/hooks/use-vault-browser";
import type { FileItem } from "./vault-types";
import { lifecycleColors, formatFileSize } from "./vault-types";
import { FolderAccessDialog } from "./folder-access-dialog";

// Supabase's joined `folder:folders(...)` embed is typed loosely and may
// arrive as either a single object or a single-element array depending on
// the FK cardinality inference. Normalize at read-time so the rendering
// code can treat it as a plain optional record.
function getFolderRef(
  file: FileItem
): { id: string; name: string; path: string } | null {
  const f = file.folder as
    | { id: string; name: string; path: string }
    | Array<{ id: string; name: string; path: string }>
    | null
    | undefined;
  if (!f) return null;
  if (Array.isArray(f)) return f[0] ?? null;
  return f;
}

interface VaultFileListProps {
  vault: VaultBrowserState;
  userId: string;
}

function FileThumb({ file, onRefresh }: { file: FileItem; onRefresh: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const img = e.target.files?.[0];
    if (!img) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("image", img);
      const res = await fetch(`/api/files/${file.id}/thumbnail/set`, { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to upload thumbnail");
        return;
      }
      toast.success("Thumbnail updated");
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to upload thumbnail");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  if (file.thumbnailUrl) {
    return (
      <div className="relative w-12 h-12 rounded overflow-hidden bg-muted/30 shrink-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={file.thumbnailUrl} alt="" className="w-full h-full object-cover" />
        {file.isCheckedOut && <Lock className="w-3 h-3 text-red-500 absolute -top-0.5 -right-0.5" />}
      </div>
    );
  }
  // No thumbnail: show the generic icon with a hover overlay that opens a
  // hidden file picker. Frozen files can't have their thumbnail changed
  // (enforced server-side), so we hide the affordance for them to avoid
  // the extra round-trip failure.
  const canUpload = !file.isFrozen;
  return (
    <div className="group relative shrink-0 w-12 h-12 flex items-center justify-center">
      {file.category === "PART" || file.category === "ASSEMBLY" || file.category === "MODEL_3D" ? <FileIcon className="w-7 h-7 text-orange-500" /> : file.category === "DRAWING" || file.category === "DRAWING_2D" ? <FileText className="w-7 h-7 text-green-600" /> : <FileText className="w-7 h-7 text-muted-foreground" />}
      {file.isCheckedOut && <Lock className="w-3 h-3 text-red-500 absolute top-0 right-0" />}
      {canUpload && (
        <>
          <button
            type="button"
            title="Set thumbnail"
            aria-label="Set thumbnail"
            onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}
            disabled={uploading}
            className="absolute inset-0 rounded bg-black/50 text-white opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity flex items-center justify-center"
          >
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImagePlus className="w-4 h-4" />}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/jpg,image/webp"
            className="hidden"
            onClick={(e) => e.stopPropagation()}
            onChange={handleUpload}
          />
        </>
      )}
    </div>
  );
}

function ApprovalBadges({ file }: { file: FileItem }) {
  return (
    <>
      {file.approvalStatus === "PENDING" && (
        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-orange-500/10 text-orange-600 dark:text-orange-400">
          <Clock className="w-2.5 h-2.5 mr-0.5" />Pending
        </Badge>
      )}
      {file.approvalStatus === "REJECTED" && (
        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-red-500/10 text-red-600 dark:text-red-400">
          <XCircle className="w-2.5 h-2.5 mr-0.5" />Rejected
        </Badge>
      )}
    </>
  );
}

function FileContextMenu({ file, vault, userId }: { file: FileItem; vault: VaultBrowserState; userId: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={(e) => e.stopPropagation()}>
          <MoreHorizontal className="w-4 h-4" />
        </Button>
      } />
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); vault.selectFile(file.id); }}><Eye className="w-4 h-4 mr-2" />Details</DropdownMenuItem>
        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); vault.handleDownload(file.id); }}><Download className="w-4 h-4 mr-2" />Download</DropdownMenuItem>
        <DropdownMenuSeparator />
        {!file.isCheckedOut && <DropdownMenuItem onClick={(e) => { e.stopPropagation(); vault.handleCheckout(file.id); }}><LogOut className="w-4 h-4 mr-2" />Check Out</DropdownMenuItem>}
        {file.isCheckedOut && file.checkedOutById === userId && <DropdownMenuItem onClick={(e) => { e.stopPropagation(); vault.setCheckInFileId(file.id); }}><LogIn className="w-4 h-4 mr-2" />Check In</DropdownMenuItem>}
        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); vault.openTransitionDialog(file.id, file.name, file.lifecycleId ?? null); }}><ArrowRightLeft className="w-4 h-4 mr-2" />Change State</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); vault.setRenameTarget({ id: file.id, name: file.name, type: "file" }); vault.setNewName(file.name); }}><Pencil className="w-4 h-4 mr-2" />Rename</DropdownMenuItem>
        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); vault.openMoveDialog(file.id, file.name); }}><FolderInput className="w-4 h-4 mr-2" />Move</DropdownMenuItem>
        <DropdownMenuItem className="text-destructive" onClick={(e) => { e.stopPropagation(); vault.setDeleteTarget({ id: file.id, name: file.name, type: "file" }); }}><Trash2 className="w-4 h-4 mr-2" />Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FolderContextMenu({
  folder,
  vault,
  onManageAccess,
}: {
  folder: { id: string; name: string };
  vault: VaultBrowserState;
  onManageAccess: (folder: { id: string; name: string }) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0" onClick={(e) => e.stopPropagation()}>
          <MoreHorizontal className="w-4 h-4" />
        </Button>
      } />
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); vault.setRenameTarget({ id: folder.id, name: folder.name, type: "folder" }); vault.setNewName(folder.name); }}>
          <Pencil className="w-4 h-4 mr-2" />Rename
        </DropdownMenuItem>
        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onManageAccess(folder); }}>
          <Shield className="w-4 h-4 mr-2" />Manage access
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive" onClick={(e) => { e.stopPropagation(); vault.setDeleteTarget({ id: folder.id, name: folder.name, type: "folder" }); }}>
          <Trash2 className="w-4 h-4 mr-2" />Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function VaultFileList({ vault, userId }: VaultFileListProps) {
  const { folders, filteredFiles, loading, selectedFile, selectedFiles, dragFileId, dropTargetId } = vault;
  const [accessFolder, setAccessFolder] = useState<{ id: string; name: string } | null>(null);

  const isFlat = vault.viewMode !== "folder";
  // When inside a subfolder, expose the parent as a ".." row so users can
  // navigate up and drag files out by dropping onto it.
  const parentFolder =
    !isFlat && vault.breadcrumbs.length > 1
      ? vault.breadcrumbs[vault.breadcrumbs.length - 2]
      : null;
  const filtered = vault.searchQuery || vault.filterState !== "all";
  // Empty-state copy varies by context: a flat view with no rows means
  // "you have nothing in this category", which is different from "this
  // folder is empty" or "your filters excluded everything".
  const emptyMessage = filtered
    ? "No files match your filters."
    : isFlat
      ? vault.viewMode === "checkouts"
        ? "You have no files checked out."
        : "Nothing to show here."
      : "Empty folder.";
  const emptyMessageDesktop = filtered
    ? "No files match your filters."
    : isFlat
      ? vault.viewMode === "checkouts"
        ? "You have no files checked out."
        : "Nothing to show here."
      : "Empty folder. Create a subfolder or upload files.";

  // Show the "Loading…" placeholder only on the very first load. On subsequent
  // folder navigations, keep the previous rows and fade them via the opacity
  // transition below so navigation feels continuous instead of flashing.
  const isInitialLoad = loading && folders.length === 0 && filteredFiles.length === 0;

  return (
    <div className="flex gap-4">
      <div className={`flex-1 min-w-0 transition-opacity duration-150 ${loading && !isInitialLoad ? "opacity-60" : "opacity-100"}`}>
        {/* Mobile card view */}
        <div className="md:hidden space-y-1">
          {isInitialLoad ? (
            <p className="text-center py-8 text-muted-foreground text-sm">Loading...</p>
          ) : !parentFolder && folders.length === 0 && filteredFiles.length === 0 ? (
            <p className="text-center py-8 text-muted-foreground text-sm">{emptyMessage}</p>
          ) : (
            <>
              {parentFolder && (
                <div
                  className={`flex items-center p-3 rounded-lg cursor-pointer bg-muted/30 hover:bg-blue-50 dark:hover:bg-blue-950/20 ${dropTargetId === parentFolder.id ? "ring-2 ring-primary bg-primary/10" : ""}`}
                  onClick={() => vault.navigateToBreadcrumb(vault.breadcrumbs.length - 2)}
                  onDragOver={(e) => vault.handleDragOver(e, parentFolder.id)}
                  onDragLeave={vault.handleDragLeave}
                  onDrop={(e) => vault.handleDrop(e, parentFolder.id)}
                >
                  <div className="relative shrink-0 w-12 h-12 flex items-center justify-center">
                    <FolderOpen className={`w-8 h-8 ${dropTargetId === parentFolder.id ? "text-primary" : "text-blue-500"}`} />
                    <ArrowUp className="w-3 h-3 absolute bottom-1 right-1 text-muted-foreground" />
                  </div>
                  <div className="ml-3 min-w-0">
                    <p className="text-sm font-medium text-muted-foreground">..</p>
                    <p className="text-xs text-muted-foreground truncate">{parentFolder.name}</p>
                  </div>
                </div>
              )}
              {parentFolder && folders.length === 0 && filteredFiles.length === 0 && (
                <p className="text-center py-6 text-muted-foreground text-sm">{emptyMessage}</p>
              )}
              {folders.map((folder) => (
                <div
                  key={folder.id}
                  className={`flex items-center justify-between p-3 rounded-lg cursor-pointer bg-muted/30 hover:bg-blue-50 dark:hover:bg-blue-950/20 ${dropTargetId === folder.id ? "ring-2 ring-primary bg-primary/10" : ""}`}
                  onClick={() => vault.navigateToFolder(folder)}
                  onDragOver={(e) => vault.handleDragOver(e, folder.id)}
                  onDragLeave={vault.handleDragLeave}
                  onDrop={(e) => vault.handleDrop(e, folder.id)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="relative shrink-0 w-12 h-12 flex items-center justify-center">
                      <FolderOpen className={`w-8 h-8 ${dropTargetId === folder.id ? "text-primary" : "text-blue-500"}`} />
                      {folder.isRestricted && (
                        <Lock className="w-3 h-3 text-amber-600 absolute bottom-1 right-1" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{folder.name}</p>
                      <p className="text-xs text-muted-foreground">{folder._count.files} files{folder._count.children > 0 ? `, ${folder._count.children} folders` : ""}</p>
                    </div>
                  </div>
                  <FolderContextMenu folder={folder} vault={vault} onManageAccess={setAccessFolder} />
                </div>
              ))}
              {filteredFiles.map((file) => {
                const folderRef = isFlat ? getFolderRef(file) : null;
                return (
                  <div
                    key={file.id}
                    className={`flex items-center justify-between p-3 rounded-lg cursor-pointer ${selectedFile === file.id ? "bg-primary/5" : "hover:bg-muted/50"} ${dragFileId === file.id ? "opacity-50" : ""}`}
                    onClick={() => vault.selectFile(file.id)}
                    draggable
                    onDragStart={(e) => vault.handleDragStart(e, file.id)}
                    onDragEnd={vault.handleDragEnd}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <FileThumb file={file} onRefresh={vault.refresh} />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{file.name}</p>
                        {folderRef && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              vault.navigateToFolder({ id: folderRef.id, name: folderRef.name });
                            }}
                            className="text-[11px] text-muted-foreground hover:text-foreground hover:underline truncate block max-w-full text-left"
                            title={folderRef.path}
                          >
                            in {folderRef.path || folderRef.name}
                          </button>
                        )}
                        <div className="flex items-center gap-2 mt-0.5">
                          <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${lifecycleColors[file.lifecycleState] || ""}`}>
                            {file.lifecycleState}
                          </Badge>
                          <ApprovalBadges file={file} />
                          <span className="text-[11px] text-muted-foreground font-mono">Rev {file.revision}.{file.currentVersion}</span>
                          {file.partNumber && <span className="text-[11px] text-muted-foreground">{file.partNumber}</span>}
                        </div>
                      </div>
                    </div>
                    <FileContextMenu file={file} vault={vault} userId={userId} />
                  </div>
                );
              })}
            </>
          )}
        </div>

        {/* Desktop table view */}
        <div className="hidden md:block border rounded-lg bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  {filteredFiles.length > 0 && (
                    <Checkbox
                      checked={selectedFiles.size === filteredFiles.length && filteredFiles.length > 0}
                      onCheckedChange={vault.toggleSelectAll}
                    />
                  )}
                </TableHead>
                <TableHead className="w-14"></TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Part #</TableHead>
                <TableHead>Rev</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Modified</TableHead>
                <TableHead className="w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isInitialLoad ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">Loading...</TableCell>
                </TableRow>
              ) : folders.length === 0 && filteredFiles.length === 0 && !parentFolder ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                    {emptyMessageDesktop}
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {parentFolder && (
                    <TableRow
                      className={`cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-950/20 bg-muted/30 ${dropTargetId === parentFolder.id ? "ring-2 ring-primary ring-inset bg-primary/10" : ""}`}
                      onClick={() => vault.navigateToBreadcrumb(vault.breadcrumbs.length - 2)}
                      onDragOver={(e) => vault.handleDragOver(e, parentFolder.id)}
                      onDragLeave={vault.handleDragLeave}
                      onDrop={(e) => vault.handleDrop(e, parentFolder.id)}
                    >
                      <TableCell />
                      <TableCell>
                        <div className="relative w-12 h-12 flex items-center justify-center">
                          <FolderOpen className={`w-8 h-8 ${dropTargetId === parentFolder.id ? "text-primary" : "text-blue-500"}`} />
                          <ArrowUp className="w-3 h-3 absolute bottom-1 right-1 text-muted-foreground" />
                        </div>
                      </TableCell>
                      <TableCell className="font-medium text-muted-foreground">
                        <div className="flex items-center gap-2">
                          ..
                          <span className="text-xs font-normal">{parentFolder.name}</span>
                        </div>
                      </TableCell>
                      <TableCell colSpan={6} />
                    </TableRow>
                  )}
                  {parentFolder && folders.length === 0 && filteredFiles.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center py-6 text-muted-foreground">
                        {emptyMessageDesktop}
                      </TableCell>
                    </TableRow>
                  )}
                  {folders.map((folder) => (
                    <TableRow
                      key={folder.id}
                      className={`cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-950/20 bg-muted/30 ${dropTargetId === folder.id ? "ring-2 ring-primary ring-inset bg-primary/10" : ""}`}
                      onClick={() => vault.navigateToFolder(folder)}
                      onDragOver={(e) => vault.handleDragOver(e, folder.id)}
                      onDragLeave={vault.handleDragLeave}
                      onDrop={(e) => vault.handleDrop(e, folder.id)}
                    >
                      <TableCell />
                      <TableCell>
                        <div className="relative w-12 h-12 flex items-center justify-center">
                          <FolderOpen className={`w-8 h-8 ${dropTargetId === folder.id ? "text-primary" : "text-blue-500"}`} />
                          {folder.isRestricted && (
                            <Lock className="w-3 h-3 text-amber-600 absolute bottom-1 right-1" />
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          {folder.name}
                          <span className="text-xs text-muted-foreground font-normal">{folder._count.files} files{folder._count.children > 0 ? `, ${folder._count.children} folders` : ""}</span>
                        </div>
                      </TableCell>
                      <TableCell colSpan={5} />
                      <TableCell>
                        <FolderContextMenu folder={folder} vault={vault} onManageAccess={setAccessFolder} />
                      </TableCell>
                    </TableRow>
                  ))}
                  {filteredFiles.map((file) => {
                    const latestVersion = file.versions[0];
                    const folderRef = isFlat ? getFolderRef(file) : null;
                    return (
                      <TableRow
                        key={file.id}
                        className={`cursor-pointer hover:bg-muted/50 ${selectedFile === file.id ? "bg-primary/5" : ""} ${dragFileId === file.id ? "opacity-50" : ""}`}
                        onClick={() => vault.selectFile(file.id)}
                        draggable
                        onDragStart={(e) => vault.handleDragStart(e, file.id)}
                        onDragEnd={vault.handleDragEnd}
                      >
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Checkbox checked={selectedFiles.has(file.id)} onCheckedChange={() => vault.toggleFileSelect(file.id)} />
                        </TableCell>
                        <TableCell>
                          <FileThumb file={file} onRefresh={vault.refresh} />
                        </TableCell>
                        <TableCell className="font-medium">
                          <div>{file.name}
                            {file.isCheckedOut && <span className="text-[11px] text-red-500 ml-1.5">({file.checkedOutBy?.fullName})</span>}
                          </div>
                          {folderRef && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                vault.navigateToFolder({ id: folderRef.id, name: folderRef.name });
                              }}
                              className="text-[11px] text-muted-foreground hover:text-foreground hover:underline font-normal truncate block max-w-full text-left mt-0.5"
                              title={folderRef.path}
                            >
                              in {folderRef.path || folderRef.name}
                            </button>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">{file.partNumber || "—"}</TableCell>
                        <TableCell className="font-mono text-xs">{file.revision}.{file.currentVersion}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <Badge variant="secondary" className={lifecycleColors[file.lifecycleState] || ""}>{file.lifecycleState}</Badge>
                            <ApprovalBadges file={file} />
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">{latestVersion ? formatFileSize(latestVersion.fileSize) : "—"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground"><FormattedDate date={file.updatedAt} variant="date" /></TableCell>
                        <TableCell>
                          <FileContextMenu file={file} vault={vault} userId={userId} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <FolderAccessDialog
        open={!!accessFolder}
        onOpenChange={(open) => { if (!open) setAccessFolder(null); }}
        folderId={accessFolder?.id ?? null}
        folderName={accessFolder?.name ?? ""}
        onChanged={() => vault.refresh()}
      />
    </div>
  );
}
