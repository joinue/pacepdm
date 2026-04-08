"use client";

import React from "react";
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
  ArrowRightLeft, Lock, Clock, XCircle,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { VaultBrowserState } from "@/hooks/use-vault-browser";
import type { FileItem } from "./vault-types";
import { lifecycleColors, formatFileSize } from "./vault-types";

interface VaultFileListProps {
  vault: VaultBrowserState;
  userId: string;
}

function FileThumb({ file }: { file: FileItem }) {
  if (file.thumbnailUrl) {
    return (
      <div className="relative w-8 h-8 rounded overflow-hidden bg-muted/30 shrink-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={file.thumbnailUrl} alt="" className="w-full h-full object-cover" />
        {file.isCheckedOut && <Lock className="w-2.5 h-2.5 text-red-500 absolute -top-0.5 -right-0.5" />}
      </div>
    );
  }
  return (
    <div className="relative shrink-0">
      {file.category === "PART" || file.category === "ASSEMBLY" ? <FileIcon className="w-5 h-5 text-orange-500" /> : file.category === "DRAWING" ? <FileText className="w-5 h-5 text-green-600" /> : <FileText className="w-5 h-5 text-muted-foreground" />}
      {file.isCheckedOut && <Lock className="w-2.5 h-2.5 text-red-500 absolute -top-1 -right-1" />}
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

function FolderContextMenu({ folder, vault }: { folder: { id: string; name: string }; vault: VaultBrowserState }) {
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
        <DropdownMenuItem className="text-destructive" onClick={(e) => { e.stopPropagation(); vault.setDeleteTarget({ id: folder.id, name: folder.name, type: "folder" }); }}>
          <Trash2 className="w-4 h-4 mr-2" />Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function VaultFileList({ vault, userId }: VaultFileListProps) {
  const { folders, filteredFiles, loading, selectedFile, selectedFiles, dragFileId, dropTargetId } = vault;

  const emptyMessage = vault.searchQuery || vault.filterState !== "all"
    ? "No files match your filters."
    : "Empty folder.";
  const emptyMessageDesktop = vault.searchQuery || vault.filterState !== "all"
    ? "No files match your filters."
    : "Empty folder. Create a subfolder or upload files.";

  return (
    <div className="flex gap-4">
      <div className="flex-1 min-w-0">
        {/* Mobile card view */}
        <div className="md:hidden space-y-1">
          {loading ? (
            <p className="text-center py-8 text-muted-foreground text-sm">Loading...</p>
          ) : folders.length === 0 && filteredFiles.length === 0 ? (
            <p className="text-center py-8 text-muted-foreground text-sm">{emptyMessage}</p>
          ) : (
            <>
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
                    <FolderOpen className={`w-5 h-5 shrink-0 ${dropTargetId === folder.id ? "text-primary" : "text-blue-500"}`} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{folder.name}</p>
                      <p className="text-xs text-muted-foreground">{folder._count.files} files{folder._count.children > 0 ? `, ${folder._count.children} folders` : ""}</p>
                    </div>
                  </div>
                  <FolderContextMenu folder={folder} vault={vault} />
                </div>
              ))}
              {filteredFiles.map((file) => (
                <div
                  key={file.id}
                  className={`flex items-center justify-between p-3 rounded-lg cursor-pointer ${selectedFile === file.id ? "bg-primary/5" : "hover:bg-muted/50"} ${dragFileId === file.id ? "opacity-50" : ""}`}
                  onClick={() => vault.selectFile(file.id)}
                  draggable
                  onDragStart={(e) => vault.handleDragStart(e, file.id)}
                  onDragEnd={vault.handleDragEnd}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <FileThumb file={file} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{file.name}</p>
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
              ))}
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
                <TableHead className="w-7"></TableHead>
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
              {loading ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">Loading...</TableCell>
                </TableRow>
              ) : folders.length === 0 && filteredFiles.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                    {emptyMessageDesktop}
                  </TableCell>
                </TableRow>
              ) : (
                <>
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
                      <TableCell><FolderOpen className={`w-5 h-5 ${dropTargetId === folder.id ? "text-primary" : "text-blue-500"}`} /></TableCell>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          {folder.name}
                          <span className="text-xs text-muted-foreground font-normal">{folder._count.files} files{folder._count.children > 0 ? `, ${folder._count.children} folders` : ""}</span>
                        </div>
                      </TableCell>
                      <TableCell colSpan={4} />
                      <TableCell>
                        <FolderContextMenu folder={folder} vault={vault} />
                      </TableCell>
                    </TableRow>
                  ))}
                  {filteredFiles.map((file) => {
                    const latestVersion = file.versions[0];
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
                          <FileThumb file={file} />
                        </TableCell>
                        <TableCell className="font-medium">
                          {file.name}
                          {file.isCheckedOut && <span className="text-[11px] text-red-500 ml-1.5">({file.checkedOutBy?.fullName})</span>}
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
    </div>
  );
}
