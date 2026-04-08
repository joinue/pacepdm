"use client";

import { useState, useEffect, useCallback } from "react";
import { useTenantUser } from "@/components/providers/tenant-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  FolderOpen, FolderPlus, Upload, FileText, Lock, MoreHorizontal,
  Download, LogIn, LogOut, Eye, File as FileIcon, Pencil, Trash2,
  FolderInput, ArrowRightLeft,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { CreateFolderDialog } from "./create-folder-dialog";
import { UploadFileDialog } from "./upload-file-dialog";
import { FileDetailPanel } from "./file-detail-panel";
import { CheckInDialog } from "./checkin-dialog";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";

interface FolderItem {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  _count: { children: number; files: number };
}

interface FileItem {
  id: string;
  name: string;
  partNumber: string | null;
  description: string | null;
  fileType: string;
  category: string;
  currentVersion: number;
  lifecycleState: string;
  lifecycleId: string | null;
  isCheckedOut: boolean;
  checkedOutById: string | null;
  checkedOutBy: { fullName: string } | null;
  updatedAt: string;
  versions: {
    version: number;
    fileSize: number;
    createdAt: string;
    uploadedBy: { fullName: string };
  }[];
}

interface MetadataFieldDef {
  id: string;
  name: string;
  fieldType: string;
  options: string[] | null;
  isRequired: boolean;
}

interface BreadcrumbEntry {
  id: string;
  name: string;
}

export function VaultBrowser({
  rootFolderId,
  metadataFields,
}: {
  rootFolderId: string;
  metadataFields: MetadataFieldDef[];
}) {
  const user = useTenantUser();
  const [currentFolderId, setCurrentFolderId] = useState(rootFolderId);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbEntry[]>([
    { id: rootFolderId, name: "Vault" },
  ]);
  const [loading, setLoading] = useState(true);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [checkInFileId, setCheckInFileId] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());

  // Rename state
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string; type: "file" | "folder" } | null>(null);
  const [newName, setNewName] = useState("");

  // Delete state
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string; type: "file" | "folder" } | null>(null);

  // Transition state
  const [transitionTarget, setTransitionTarget] = useState<{ fileId: string; fileName: string } | null>(null);
  const [transitions, setTransitions] = useState<{ id: string; name: string; toState: { name: string } }[]>([]);

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

  useEffect(() => {
    loadContents(currentFolderId);
  }, [currentFolderId, loadContents]);

  function navigateToFolder(folder: FolderItem) {
    setCurrentFolderId(folder.id);
    setBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
    setSelectedFile(null);
  }

  function navigateToBreadcrumb(index: number) {
    const entry = breadcrumbs[index];
    setCurrentFolderId(entry.id);
    setBreadcrumbs(breadcrumbs.slice(0, index + 1));
    setSelectedFile(null);
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
    if (deleteTarget.type === "file" && selectedFile === deleteTarget.id) setSelectedFile(null);
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
    // Fetch transitions from the current state
    const db = await fetch(`/api/lifecycle/${lifecycleId}/transitions?fromState=${file.lifecycleState}`);
    const data = await db.json();
    setTransitions(Array.isArray(data) ? data : []);
    setTransitionTarget({ fileId, fileName });
  }

  async function handleBulkDownload() {
    for (const fid of selectedFiles) {
      await handleDownload(fid);
    }
  }

  async function handleBulkDelete() {
    for (const fid of selectedFiles) {
      await fetch(`/api/files/${fid}/delete`, { method: "DELETE" });
    }
    toast.success(`${selectedFiles.size} file(s) deleted`);
    setSelectedFiles(new Set());
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

  function toggleSelectAll() {
    if (selectedFiles.size === files.length) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(files.map((f) => f.id)));
    }
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  const lifecycleColors: Record<string, string> = {
    WIP: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
    "In Review": "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    Released: "bg-green-500/10 text-green-600 dark:text-green-400",
    Obsolete: "bg-red-500/10 text-red-600 dark:text-red-400",
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold">Vault</h2>
          <Breadcrumb className="mt-1">
            <BreadcrumbList>
              {breadcrumbs.map((entry, i) => (
                <BreadcrumbItem key={entry.id}>
                  {i > 0 && <BreadcrumbSeparator />}
                  <BreadcrumbLink onClick={() => navigateToBreadcrumb(i)} className="cursor-pointer text-xs sm:text-sm">
                    {entry.name}
                  </BreadcrumbLink>
                </BreadcrumbItem>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
        </div>
        <div className="flex gap-2 flex-wrap">
          {selectedFiles.size > 0 && (
            <>
              <Button variant="outline" size="sm" onClick={handleBulkDownload}>
                <Download className="w-4 h-4 sm:mr-1" />
                <span className="hidden sm:inline">Download ({selectedFiles.size})</span>
              </Button>
              <Button variant="destructive" size="sm" onClick={handleBulkDelete}>
                <Trash2 className="w-4 h-4 sm:mr-1" />
                <span className="hidden sm:inline">Delete ({selectedFiles.size})</span>
              </Button>
            </>
          )}
          <Button variant="outline" size="sm" onClick={() => setShowCreateFolder(true)}>
            <FolderPlus className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">New Folder</span>
          </Button>
          <Button size="sm" onClick={() => setShowUpload(true)}>
            <Upload className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Upload</span>
          </Button>
        </div>
      </div>

      <div className="flex gap-4">
        <div className="flex-1 min-w-0">
          {/* Mobile card view */}
          <div className="md:hidden space-y-1">
            {loading ? (
              <p className="text-center py-8 text-muted-foreground text-sm">Loading...</p>
            ) : folders.length === 0 && files.length === 0 ? (
              <p className="text-center py-8 text-muted-foreground text-sm">Empty folder.</p>
            ) : (
              <>
                {folders.map((folder) => (
                  <div key={folder.id} className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 cursor-pointer" onClick={() => navigateToFolder(folder)}>
                    <div className="flex items-center gap-3 min-w-0">
                      <FolderOpen className="w-5 h-5 text-blue-500 shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{folder.name}</p>
                        <p className="text-xs text-muted-foreground">{folder._count.files} files</p>
                      </div>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0" onClick={(e) => e.stopPropagation()}>
                          <MoreHorizontal className="w-4 h-4" />
                        </Button>
                      } />
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setRenameTarget({ id: folder.id, name: folder.name, type: "folder" }); setNewName(folder.name); }}>
                          <Pencil className="w-4 h-4 mr-2" />Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem className="text-destructive" onClick={(e) => { e.stopPropagation(); setDeleteTarget({ id: folder.id, name: folder.name, type: "folder" }); }}>
                          <Trash2 className="w-4 h-4 mr-2" />Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))}
                {files.map((file) => (
                  <div key={file.id} className={`flex items-center justify-between p-3 rounded-lg cursor-pointer ${selectedFile === file.id ? "bg-primary/5" : "hover:bg-muted/50"}`} onClick={() => setSelectedFile(file.id)}>
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="relative shrink-0">
                        {file.category === "PART" || file.category === "ASSEMBLY" ? (
                          <FileIcon className="w-5 h-5 text-orange-500" />
                        ) : file.category === "DRAWING" ? (
                          <FileText className="w-5 h-5 text-green-600" />
                        ) : (
                          <FileText className="w-5 h-5 text-muted-foreground" />
                        )}
                        {file.isCheckedOut && <Lock className="w-2.5 h-2.5 text-red-500 absolute -top-1 -right-1" />}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{file.name}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${lifecycleColors[file.lifecycleState] || ""}`}>
                            {file.lifecycleState}
                          </Badge>
                          <span className="text-[11px] text-muted-foreground font-mono">v{file.currentVersion}</span>
                          {file.partNumber && <span className="text-[11px] text-muted-foreground">{file.partNumber}</span>}
                        </div>
                      </div>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0" onClick={(e) => e.stopPropagation()}>
                          <MoreHorizontal className="w-4 h-4" />
                        </Button>
                      } />
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setSelectedFile(file.id); }}><Eye className="w-4 h-4 mr-2" />Details</DropdownMenuItem>
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleDownload(file.id); }}><Download className="w-4 h-4 mr-2" />Download</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {!file.isCheckedOut && <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleCheckout(file.id); }}><LogOut className="w-4 h-4 mr-2" />Check Out</DropdownMenuItem>}
                        {file.isCheckedOut && file.checkedOutById === user.id && <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setCheckInFileId(file.id); }}><LogIn className="w-4 h-4 mr-2" />Check In</DropdownMenuItem>}
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); openTransitionDialog(file.id, file.name, file.lifecycleId ?? null); }}><ArrowRightLeft className="w-4 h-4 mr-2" />Change State</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setRenameTarget({ id: file.id, name: file.name, type: "file" }); setNewName(file.name); }}><Pencil className="w-4 h-4 mr-2" />Rename</DropdownMenuItem>
                        <DropdownMenuItem className="text-destructive" onClick={(e) => { e.stopPropagation(); setDeleteTarget({ id: file.id, name: file.name, type: "file" }); }}><Trash2 className="w-4 h-4 mr-2" />Delete</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
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
                  <TableHead className="w-[32px]">
                    {files.length > 0 && (
                      <Checkbox
                        checked={selectedFiles.size === files.length && files.length > 0}
                        onCheckedChange={toggleSelectAll}
                      />
                    )}
                  </TableHead>
                  <TableHead className="w-[28px]"></TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Part #</TableHead>
                  <TableHead>Ver</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Modified</TableHead>
                  <TableHead className="w-[40px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">Loading...</TableCell>
                  </TableRow>
                ) : folders.length === 0 && files.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                      Empty folder. Create a subfolder or upload files.
                    </TableCell>
                  </TableRow>
                ) : (
                  <>
                    {folders.map((folder) => (
                      <TableRow key={folder.id} className="cursor-pointer hover:bg-muted/50" onDoubleClick={() => navigateToFolder(folder)}>
                        <TableCell />
                        <TableCell><FolderOpen className="w-4 h-4 text-blue-500" /></TableCell>
                        <TableCell className="font-medium cursor-pointer" onClick={() => navigateToFolder(folder)}>{folder.name}</TableCell>
                        <TableCell className="text-muted-foreground">—</TableCell>
                        <TableCell className="text-muted-foreground">—</TableCell>
                        <TableCell className="text-muted-foreground">—</TableCell>
                        <TableCell className="text-muted-foreground text-xs">{folder._count.children}f, {folder._count.files} files</TableCell>
                        <TableCell className="text-muted-foreground">—</TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger render={
                              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={(e) => e.stopPropagation()}>
                                <MoreHorizontal className="w-4 h-4" />
                              </Button>
                            } />
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => { setRenameTarget({ id: folder.id, name: folder.name, type: "folder" }); setNewName(folder.name); }}>
                                <Pencil className="w-4 h-4 mr-2" />Rename
                              </DropdownMenuItem>
                              <DropdownMenuItem className="text-destructive" onClick={() => setDeleteTarget({ id: folder.id, name: folder.name, type: "folder" })}>
                                <Trash2 className="w-4 h-4 mr-2" />Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                    {files.map((file) => {
                      const latestVersion = file.versions[0];
                      return (
                        <TableRow key={file.id} className={`cursor-pointer hover:bg-muted/50 ${selectedFile === file.id ? "bg-primary/5" : ""}`} onClick={() => setSelectedFile(file.id)}>
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <Checkbox checked={selectedFiles.has(file.id)} onCheckedChange={() => toggleFileSelect(file.id)} />
                          </TableCell>
                          <TableCell>
                            <div className="relative">
                              {file.category === "PART" || file.category === "ASSEMBLY" ? <FileIcon className="w-4 h-4 text-orange-500" /> : file.category === "DRAWING" ? <FileText className="w-4 h-4 text-green-600" /> : <FileText className="w-4 h-4 text-muted-foreground" />}
                              {file.isCheckedOut && <Lock className="w-2.5 h-2.5 text-red-500 absolute -top-1 -right-1" />}
                            </div>
                          </TableCell>
                          <TableCell className="font-medium">
                            {file.name}
                            {file.isCheckedOut && <span className="text-[11px] text-red-500 ml-1.5">({file.checkedOutBy?.fullName})</span>}
                          </TableCell>
                          <TableCell className="text-sm">{file.partNumber || "—"}</TableCell>
                          <TableCell className="font-mono text-xs">v{file.currentVersion}</TableCell>
                          <TableCell><Badge variant="secondary" className={lifecycleColors[file.lifecycleState] || ""}>{file.lifecycleState}</Badge></TableCell>
                          <TableCell className="text-sm">{latestVersion ? formatFileSize(latestVersion.fileSize) : "—"}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{new Date(file.updatedAt).toLocaleDateString()}</TableCell>
                          <TableCell>
                            <DropdownMenu>
                              <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={(e) => e.stopPropagation()}><MoreHorizontal className="w-4 h-4" /></Button>} />
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setSelectedFile(file.id); }}><Eye className="w-4 h-4 mr-2" />Details</DropdownMenuItem>
                                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleDownload(file.id); }}><Download className="w-4 h-4 mr-2" />Download</DropdownMenuItem>
                                <DropdownMenuSeparator />
                                {!file.isCheckedOut && <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleCheckout(file.id); }}><LogOut className="w-4 h-4 mr-2" />Check Out</DropdownMenuItem>}
                                {file.isCheckedOut && file.checkedOutById === user.id && <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setCheckInFileId(file.id); }}><LogIn className="w-4 h-4 mr-2" />Check In</DropdownMenuItem>}
                                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); openTransitionDialog(file.id, file.name, file.lifecycleId ?? null); }}><ArrowRightLeft className="w-4 h-4 mr-2" />Change State</DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setRenameTarget({ id: file.id, name: file.name, type: "file" }); setNewName(file.name); }}><Pencil className="w-4 h-4 mr-2" />Rename</DropdownMenuItem>
                                <DropdownMenuItem className="text-destructive" onClick={(e) => { e.stopPropagation(); setDeleteTarget({ id: file.id, name: file.name, type: "file" }); }}><Trash2 className="w-4 h-4 mr-2" />Delete</DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
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

        {/* Detail panel — side panel on desktop, sheet on mobile */}
        {selectedFile && (
          <>
            <div className="hidden md:block">
              <FileDetailPanel fileId={selectedFile} metadataFields={metadataFields} onClose={() => setSelectedFile(null)} onRefresh={() => loadContents(currentFolderId)} />
            </div>
            <Sheet open={!!selectedFile} onOpenChange={(open) => { if (!open) setSelectedFile(null); }}>
              <SheetContent side="right" className="w-full sm:w-96 p-0 md:hidden">
                <FileDetailPanel fileId={selectedFile} metadataFields={metadataFields} onClose={() => setSelectedFile(null)} onRefresh={() => loadContents(currentFolderId)} />
              </SheetContent>
            </Sheet>
          </>
        )}
      </div>

      {/* Dialogs */}
      <CreateFolderDialog open={showCreateFolder} onOpenChange={setShowCreateFolder} parentId={currentFolderId} onCreated={() => loadContents(currentFolderId)} />
      <UploadFileDialog open={showUpload} onOpenChange={setShowUpload} folderId={currentFolderId} onUploaded={() => loadContents(currentFolderId)} />
      {checkInFileId && <CheckInDialog open={!!checkInFileId} onOpenChange={(open) => !open && setCheckInFileId(null)} fileId={checkInFileId} onCheckedIn={() => { setCheckInFileId(null); loadContents(currentFolderId); }} />}

      {/* Rename Dialog */}
      <Dialog open={!!renameTarget} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename {renameTarget?.type}</DialogTitle>
            <DialogDescription>Enter a new name for &ldquo;{renameTarget?.name}&rdquo;</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="rename">New name</Label>
            <Input id="rename" value={newName} onChange={(e) => setNewName(e.target.value)} className="mt-2" onKeyDown={(e) => e.key === "Enter" && handleRename()} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>Cancel</Button>
            <Button onClick={handleRename} disabled={!newName.trim() || newName === renameTarget?.name}>Rename</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.type}?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &ldquo;{deleteTarget?.name}&rdquo;? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Transition Dialog */}
      <Dialog open={!!transitionTarget} onOpenChange={(open) => !open && setTransitionTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change Lifecycle State</DialogTitle>
            <DialogDescription>Select a transition for &ldquo;{transitionTarget?.fileName}&rdquo;</DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-2">
            {transitions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No transitions available from the current state.</p>
            ) : (
              transitions.map((t) => (
                <Button key={t.id} variant="outline" className="w-full justify-start" onClick={() => handleTransition(t.id)}>
                  <ArrowRightLeft className="w-4 h-4 mr-2" />
                  {t.name} &rarr; {t.toState.name}
                </Button>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
