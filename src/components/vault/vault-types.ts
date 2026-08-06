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

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}

/**
 * Native SolidWorks documents. Proprietary OLE binaries — occt-import-js is
 * OpenCascade and cannot read them, so the only thing extractable is the
 * embedded 2D preview bitmap. No amount of viewer work changes that.
 */
const NATIVE_CAD_EXTENSIONS = ["sldprt", "sldasm", "slddrw"];

/**
 * Formats the 3D viewer can actually open. Kept in step with the viewer's own
 * list and with the public share endpoint's `PREVIEWABLE_CAD`.
 */
const NEUTRAL_CAD_EXTENSIONS = ["step", "stp", "iges", "igs", "stl", "obj"];

function extensionOf(fileName: string): string {
  const parts = fileName.split(".");
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
}

/**
 * True when this file will only ever have a 2D preview, so uploading a neutral
 * export alongside it is worth suggesting.
 *
 * Deliberately a suggestion and not a gate — see
 * docs/decisions/retention-and-formats.md. Refusing the check-in puts the
 * friction on somebody mid-task, and the first person in a hurry attaches a
 * stale STEP, which is worse than attaching none because it looks current.
 */
export function needsNeutralExport(fileName: string): boolean {
  return NATIVE_CAD_EXTENSIONS.includes(extensionOf(fileName));
}

/** True when the file is one the 3D viewer can open on its own. */
export function isNeutralCadFile(fileName: string): boolean {
  return NEUTRAL_CAD_EXTENSIONS.includes(extensionOf(fileName));
}
