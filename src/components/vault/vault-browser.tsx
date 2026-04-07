"use client";

import { useState, useEffect, useCallback } from "react";
import { useTenantUser } from "@/components/providers/tenant-provider";
import { Button } from "@/components/ui/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  FolderOpen,
  FolderPlus,
  Upload,
  FileText,
  Lock,
  MoreHorizontal,
  Download,
  LogIn,
  LogOut,
  Eye,
  File as FileIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CreateFolderDialog } from "./create-folder-dialog";
import { UploadFileDialog } from "./upload-file-dialog";
import { FileDetailPanel } from "./file-detail-panel";
import { CheckInDialog } from "./checkin-dialog";
import { toast } from "sonner";

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
    try {
      const res = await fetch(`/api/files/${fileId}/checkout`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to check out");
        return;
      }
      toast.success("File checked out");
      loadContents(currentFolderId);
    } catch {
      toast.error("Failed to check out file");
    }
  }

  async function handleDownload(fileId: string) {
    try {
      const res = await fetch(`/api/files/${fileId}/download`);
      const data = await res.json();
      if (data.url) {
        window.open(data.url, "_blank");
      } else {
        toast.error(data.error || "Failed to download");
      }
    } catch {
      toast.error("Failed to download file");
    }
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  const lifecycleColors: Record<string, string> = {
    WIP: "bg-yellow-100 text-yellow-800",
    "In Review": "bg-blue-100 text-blue-800",
    Released: "bg-green-100 text-green-800",
    Obsolete: "bg-red-100 text-red-800",
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Vault</h2>
          <Breadcrumb className="mt-1">
            <BreadcrumbList>
              {breadcrumbs.map((entry, i) => (
                <BreadcrumbItem key={entry.id}>
                  {i > 0 && <BreadcrumbSeparator />}
                  <BreadcrumbLink
                    onClick={() => navigateToBreadcrumb(i)}
                    className="cursor-pointer"
                  >
                    {entry.name}
                  </BreadcrumbLink>
                </BreadcrumbItem>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowCreateFolder(true)}
          >
            <FolderPlus className="w-4 h-4 mr-2" />
            New Folder
          </Button>
          <Button size="sm" onClick={() => setShowUpload(true)}>
            <Upload className="w-4 h-4 mr-2" />
            Upload File
          </Button>
        </div>
      </div>

      <div className="flex gap-4">
        {/* File table */}
        <div className="flex-1 border rounded-lg bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[40px]"></TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Part Number</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Modified</TableHead>
                <TableHead className="w-[40px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8">
                    Loading...
                  </TableCell>
                </TableRow>
              ) : folders.length === 0 && files.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={8}
                    className="text-center py-8 text-muted-foreground"
                  >
                    This folder is empty. Create a subfolder or upload a file.
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {/* Folders */}
                  {folders.map((folder) => (
                    <TableRow
                      key={folder.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onDoubleClick={() => navigateToFolder(folder)}
                    >
                      <TableCell>
                        <FolderOpen className="w-4 h-4 text-blue-500" />
                      </TableCell>
                      <TableCell
                        className="font-medium cursor-pointer"
                        onClick={() => navigateToFolder(folder)}
                      >
                        {folder.name}
                      </TableCell>
                      <TableCell className="text-muted-foreground">—</TableCell>
                      <TableCell className="text-muted-foreground">—</TableCell>
                      <TableCell className="text-muted-foreground">—</TableCell>
                      <TableCell className="text-muted-foreground">
                        {folder._count.children} folders, {folder._count.files}{" "}
                        files
                      </TableCell>
                      <TableCell className="text-muted-foreground">—</TableCell>
                      <TableCell />
                    </TableRow>
                  ))}

                  {/* Files */}
                  {files.map((file) => {
                    const latestVersion = file.versions[0];
                    return (
                      <TableRow
                        key={file.id}
                        className={`cursor-pointer hover:bg-muted/50 ${
                          selectedFile === file.id ? "bg-primary/5" : ""
                        }`}
                        onClick={() => setSelectedFile(file.id)}
                      >
                        <TableCell>
                          <div className="relative">
                            {file.category === "PART" ||
                            file.category === "ASSEMBLY" ? (
                              <FileIcon className="w-4 h-4 text-orange-500" />
                            ) : file.category === "DRAWING" ? (
                              <FileText className="w-4 h-4 text-green-600" />
                            ) : (
                              <FileText className="w-4 h-4 text-gray-500" />
                            )}
                            {file.isCheckedOut && (
                              <Lock className="w-3 h-3 text-red-500 absolute -top-1 -right-1" />
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="font-medium">
                          <div>
                            {file.name}
                            {file.isCheckedOut && (
                              <span className="text-xs text-red-500 ml-2">
                                ({file.checkedOutBy?.fullName})
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>{file.partNumber || "—"}</TableCell>
                        <TableCell>v{file.currentVersion}</TableCell>
                        <TableCell>
                          <Badge
                            variant="secondary"
                            className={
                              lifecycleColors[file.lifecycleState] || ""
                            }
                          >
                            {file.lifecycleState}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {latestVersion
                            ? formatFileSize(latestVersion.fileSize)
                            : "—"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {new Date(file.updatedAt).toLocaleDateString()}
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-8 w-8 p-0"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <MoreHorizontal className="w-4 h-4" />
                                </Button>
                              }
                            />
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedFile(file.id);
                                }}
                              >
                                <Eye className="w-4 h-4 mr-2" />
                                View Details
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDownload(file.id);
                                }}
                              >
                                <Download className="w-4 h-4 mr-2" />
                                Download
                              </DropdownMenuItem>
                              {!file.isCheckedOut && (
                                <DropdownMenuItem
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleCheckout(file.id);
                                  }}
                                >
                                  <LogOut className="w-4 h-4 mr-2" />
                                  Check Out
                                </DropdownMenuItem>
                              )}
                              {file.isCheckedOut &&
                                file.checkedOutById === user.id && (
                                  <DropdownMenuItem
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setCheckInFileId(file.id);
                                    }}
                                  >
                                    <LogIn className="w-4 h-4 mr-2" />
                                    Check In
                                  </DropdownMenuItem>
                                )}
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

        {/* Detail panel */}
        {selectedFile && (
          <FileDetailPanel
            fileId={selectedFile}
            metadataFields={metadataFields}
            onClose={() => setSelectedFile(null)}
            onRefresh={() => loadContents(currentFolderId)}
          />
        )}
      </div>

      {/* Dialogs */}
      <CreateFolderDialog
        open={showCreateFolder}
        onOpenChange={setShowCreateFolder}
        parentId={currentFolderId}
        onCreated={() => loadContents(currentFolderId)}
      />

      <UploadFileDialog
        open={showUpload}
        onOpenChange={setShowUpload}
        folderId={currentFolderId}
        onUploaded={() => loadContents(currentFolderId)}
      />

      {checkInFileId && (
        <CheckInDialog
          open={!!checkInFileId}
          onOpenChange={(open) => !open && setCheckInFileId(null)}
          fileId={checkInFileId}
          onCheckedIn={() => {
            setCheckInFileId(null);
            loadContents(currentFolderId);
          }}
        />
      )}
    </div>
  );
}
