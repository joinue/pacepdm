"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FolderOpen,
  FolderPlus,
  Upload,
  Download,
  FolderDown,
  Trash2,
  Search,
  LogOut,
  ArrowLeft,
} from "lucide-react";
import type { VaultBrowserState } from "@/hooks/use-vault-browser";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/lib/permissions";

interface VaultToolbarProps {
  vault: VaultBrowserState;
}

// Human-readable metadata for each flat (cross-folder) view the vault can
// render. Keeping this map alongside the toolbar means adding a new flat
// view (e.g. "recent", "in WIP") is a single entry rather than a scatter
// of ad-hoc conditionals.
const FLAT_VIEW_META: Record<
  Exclude<VaultBrowserState["viewMode"], "folder">,
  { title: string; description: string }
> = {
  checkouts: {
    title: "My checked-out files",
    description: "Files you've checked out across every folder, oldest first.",
  },
  trash: {
    title: "Recently deleted",
    description:
      "Deleted files, newest first. Restoring puts a file back in the folder it came from.",
  },
};

export function VaultToolbar({ vault }: VaultToolbarProps) {
  const { can } = usePermissions();
  const canUpload = can(PERMISSIONS.FILE_UPLOAD);
  const canCreateFolder = can(PERMISSIONS.FOLDER_CREATE);
  const canDelete = can(PERMISSIONS.FILE_DELETE);
  const flatMeta = vault.viewMode !== "folder" ? FLAT_VIEW_META[vault.viewMode] : null;
  const isFlat = flatMeta !== null;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          {isFlat && flatMeta ? (
            <>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 -ml-2 text-muted-foreground hover:text-foreground"
                  onClick={vault.exitFlatView}
                >
                  <ArrowLeft className="w-4 h-4 mr-1" />
                  Back to vault
                </Button>
              </div>
              <h1 className="text-xl sm:text-2xl font-bold mt-1">{flatMeta.title}</h1>
              <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
                {flatMeta.description}
              </p>
            </>
          ) : (
            <VaultBreadcrumbs vault={vault} />
          )}
        </div>
        <div className="flex gap-2 flex-wrap">
          {vault.selectedFiles.size > 0 && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={vault.handleBulkDownload}
                disabled={vault.bulkDownloading}
              >
                <Download className="w-4 h-4 sm:mr-1" />
                <span className="hidden sm:inline">
                  {vault.bulkDownloading ? "Zipping..." : `Download (${vault.selectedFiles.size})`}
                </span>
              </Button>
              {canDelete && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => vault.setShowBulkDeleteConfirm(true)}
                >
                  <Trash2 className="w-4 h-4 sm:mr-1" />
                  <span className="hidden sm:inline">Delete ({vault.selectedFiles.size})</span>
                </Button>
              )}
            </>
          )}
          {/* Folder-scoped actions (download folder, create folder, upload)
              don't make sense in flat views — there's no single source/dest
              folder — so we hide them. Exiting the flat view brings them
              back. The folder-download button is also hidden at the vault
              root to discourage "download everything" misclicks. */}
          {!isFlat && vault.canDownloadFolder && (
            <Button
              variant="outline"
              size="sm"
              onClick={vault.handleFolderDownload}
              disabled={vault.folderDownloading}
              title="Download this folder and everything inside it as a ZIP"
            >
              <FolderDown className="w-4 h-4 sm:mr-2" />
              <span className="hidden sm:inline">
                {vault.folderDownloading ? "Preparing..." : "Download folder"}
              </span>
            </Button>
          )}
          {!isFlat && canCreateFolder && (
            <Button variant="outline" size="sm" onClick={() => vault.setShowCreateFolder(true)}>
              <FolderPlus className="w-4 h-4 sm:mr-2" />
              <span className="hidden sm:inline">New Folder</span>
            </Button>
          )}
          {!isFlat && canDelete && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => vault.enterFlatView("trash")}
              title="Files that have been deleted but can still be restored"
            >
              <Trash2 className="w-4 h-4 sm:mr-2" />
              <span className="hidden sm:inline">Trash</span>
            </Button>
          )}
          {!isFlat && canUpload && (
            <Button size="sm" onClick={() => vault.setShowUpload(true)}>
              <Upload className="w-4 h-4 sm:mr-2" />
              <span className="hidden sm:inline">Upload</span>
            </Button>
          )}
          {isFlat && (
            <Button variant="outline" size="sm" onClick={vault.exitFlatView}>
              <LogOut className="w-4 h-4 sm:mr-2" />
              <span className="hidden sm:inline">Exit view</span>
            </Button>
          )}
        </div>
      </div>

      {/* Search & Filter. Hidden in the trash: those controls filter the
          vault's own file list, which the trash view doesn't populate, so
          they would silently do nothing. */}
      {!vault.selectedFile && vault.viewMode !== "trash" && (
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search files by name or part number..."
              value={vault.searchQuery}
              onChange={(e) => vault.setSearchQuery(e.target.value)}
              className="pl-9 h-9"
            />
          </div>
          {vault.lifecycleStates.length > 1 && (
            <Select
              value={vault.filterState}
              onValueChange={(v) => vault.setFilterState(v ?? "all")}
            >
              <SelectTrigger className="w-full sm:w-40 h-9">
                <SelectValue placeholder="All states">
                  {(v) => (v === "all" ? "All states" : (v as string))}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All states</SelectItem>
                {vault.lifecycleStates.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The vault's page heading *is* its breadcrumb trail.
 *
 * The last crumb — the folder you're actually in — renders as the `<h1>`,
 * prefixed with the same folder icon the listing rows use, and the ancestors
 * lead into it as muted links at the same type size. At the vault root there
 * is a single crumb, so the heading is just "Vault". A separate static title
 * above the trail would only repeat what the last crumb already says.
 */
function VaultBreadcrumbs({ vault }: VaultToolbarProps) {
  // On narrow screens with deep nesting, collapse middle entries to "…" so the
  // trail stays on one line. Always show root + last 2 levels at minimum. The
  // threshold is one tighter than a body-copy breadcrumb's would be: these
  // crumbs are heading-sized, so they run out of width sooner.
  const items = vault.breadcrumbs;
  const collapsed = items.length > 3;
  const visible = collapsed
    ? [
        { ...items[0], _index: 0 },
        { id: "ellipsis", name: "…", _index: -1 },
        { ...items[items.length - 2], _index: items.length - 2 },
        { ...items[items.length - 1], _index: items.length - 1 },
      ]
    : items.map((e, i) => ({ ...e, _index: i }));

  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap gap-1.5 overflow-hidden text-xl sm:text-2xl">
        {visible.map((entry, i) => {
          const isEllipsis = entry.id === "ellipsis";
          const isCurrent = i === visible.length - 1;
          return (
            <React.Fragment key={`${entry.id}-${i}`}>
              {i > 0 && <BreadcrumbSeparator className="shrink-0 [&>svg]:size-5" />}
              <BreadcrumbItem
                onDragOver={(e) => {
                  if (!isEllipsis && entry.id !== vault.currentFolderId)
                    vault.handleDragOver(e, entry.id);
                }}
                onDragLeave={vault.handleDragLeave}
                onDrop={(e) => {
                  if (!isEllipsis && entry.id !== vault.currentFolderId)
                    vault.handleDrop(e, entry.id);
                }}
                className={`${vault.dropTargetId === entry.id ? "ring-2 ring-primary rounded px-1" : ""} min-w-0`}
              >
                {isEllipsis ? (
                  <span className="px-1 text-muted-foreground">…</span>
                ) : isCurrent ? (
                  <h1
                    aria-current="page"
                    className="flex min-w-0 items-center gap-2 font-bold text-foreground"
                    title={entry.name}
                  >
                    {/* No icon at the root: "Vault" is the whole vault, not a
                        folder inside it. */}
                    {i > 0 && <FolderOpen className="w-5 h-5 shrink-0 text-info" />}
                    <span className="truncate">{entry.name}</span>
                  </h1>
                ) : (
                  <BreadcrumbLink
                    onClick={() => vault.navigateToBreadcrumb(entry._index)}
                    className="block max-w-24 truncate cursor-pointer font-normal text-muted-foreground sm:max-w-40"
                    title={entry.name}
                  >
                    {entry.name}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </React.Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
