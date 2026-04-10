export interface FolderItem {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  isRestricted?: boolean;
  _count: { children: number; files: number };
}

export interface FileItem {
  id: string;
  name: string;
  partNumber: string | null;
  description: string | null;
  fileType: string;
  category: string;
  currentVersion: number;
  lifecycleState: string;
  lifecycleId: string | null;
  revision: string;
  isFrozen: boolean;
  isCheckedOut: boolean;
  checkedOutById: string | null;
  approvalStatus: "PENDING" | "REJECTED" | null;
  checkedOutBy: { fullName: string } | null;
  updatedAt: string;
  thumbnailUrl: string | null;
  // Populated only when the list was fetched via a flat (cross-folder) view
  // such as `?checkedOutByMe=1`, so the row can render its parent folder.
  folder?: { id: string; name: string; path: string } | null;
  versions: {
    version: number;
    fileSize: number;
    createdAt: string;
    uploadedBy: { fullName: string };
  }[];
}

export interface MetadataFieldDef {
  id: string;
  name: string;
  fieldType: string;
  options: string[] | null;
  isRequired: boolean;
}

export interface BreadcrumbEntry {
  id: string;
  name: string;
}

export interface TransitionOption {
  id: string;
  name: string;
  toState: { name: string };
}

export const lifecycleColors: Record<string, string> = {
  WIP: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
  "In Review": "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  Released: "bg-green-500/10 text-green-600 dark:text-green-400",
  Obsolete: "bg-red-500/10 text-red-600 dark:text-red-400",
};

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}
