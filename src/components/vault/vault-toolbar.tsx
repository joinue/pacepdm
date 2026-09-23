"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  Vault as VaultIcon,
} from "lucide-react";
import type { VaultBrowserState } from "@/hooks/use-vault-browser";
import { useHoverIntent } from "@/hooks/use-hover-intent";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { VAULT_ROOT_NAME, vaultHref } from "./vault-location";
import type { BreadcrumbEntry } from "./vault-types";

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
 * The trail always has the same shape: the vault, then whatever is collapsed,
 * then the folder above the current one, then the current folder as the
 * `<h1>`. At the root there is a single crumb, "Vault", with the vault's own
 * mark (the icon the sidebar uses). Below the root the word goes and the icon
 * carries it, so the folder names get the width. Everything between the vault
 * and the parent folds into a "…" menu, one click from any level. A separate
 * static title above the trail would only repeat what the last crumb says.
 *
 * Ancestor crumbs are real links to the folder's URL, so they open in a new
 * tab and take keyboard focus; a plain click navigates in place, through the
 * unsaved-edits check. Resting the pointer on one starts that folder's
 * listing ahead of the click.
 */
function VaultBreadcrumbs({ vault }: VaultToolbarProps) {
  const items = vault.breadcrumbs;
  const root = items[0];
  const current = items[items.length - 1];
  const parent = items.length > 2 ? items[items.length - 2] : null;
  // Everything between the root and the parent. Empty until the trail is four
  // deep; then the levels in between fold into the menu.
  const collapsed = items.slice(1, -2);
  const hover = useHoverIntent(vault.prefetchFolder);

  const hrefFor = (entry: BreadcrumbEntry) =>
    vaultHref({ viewMode: "folder", folderId: entry.id, fileId: null }, root.id);

  // A plain click navigates in place. A modified or middle click is the
  // browser's (new tab, new window), and the link's real href takes it there.
  const navigateOnClick = (index: number) => (e: React.MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    vault.navigateToBreadcrumb(index);
  };

  const dropTarget = (entry: BreadcrumbEntry) => ({
    onDragOver: (e: React.DragEvent) => vault.handleDragOver(e, entry.id),
    onDragLeave: vault.handleDragLeave,
    onDrop: (e: React.DragEvent) => vault.handleDrop(e, entry.id),
    className: cn("min-w-0", vault.dropTargetId === entry.id && "rounded px-1 ring-2 ring-primary"),
  });
  const prefetchOn = (entry: BreadcrumbEntry) => ({
    onPointerEnter: () => hover.begin(entry.id),
    onPointerLeave: hover.cancel,
  });
  const separator = <BreadcrumbSeparator className="shrink-0 [&>svg]:size-5" />;

  if (items.length <= 1) {
    return (
      <Breadcrumb className="min-w-0">
        <BreadcrumbList className="flex-nowrap gap-1.5 overflow-hidden text-xl sm:text-2xl">
          <BreadcrumbItem className="min-w-0">
            <h1
              aria-current="page"
              className="flex min-w-0 items-center gap-2 font-bold text-foreground"
            >
              <VaultIcon className="size-5 shrink-0 sm:size-6" aria-hidden="true" />
              <span className="truncate">{current.name}</span>
            </h1>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap gap-1.5 overflow-hidden text-xl sm:text-2xl">
        {/* The vault itself, as its icon alone; named for the tooltip and
            assistive tech. */}
        <BreadcrumbItem {...dropTarget(root)}>
          <BreadcrumbLink
            href={hrefFor(root)}
            onClick={navigateOnClick(0)}
            aria-label={VAULT_ROOT_NAME}
            title={VAULT_ROOT_NAME}
            className="flex items-center text-muted-foreground"
            {...prefetchOn(root)}
          >
            <VaultIcon className="size-5 sm:size-6" aria-hidden="true" />
          </BreadcrumbLink>
        </BreadcrumbItem>

        {collapsed.length > 0 && (
          <>
            {separator}
            <BreadcrumbItem className="shrink-0">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`${collapsed.length} more ${collapsed.length === 1 ? "folder" : "folders"}`}
                      title="Folders in between"
                      className="flex items-center rounded text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <BreadcrumbEllipsis className="size-6 [&>svg]:size-5" />
                    </button>
                  }
                />
                <DropdownMenuContent align="start">
                  {collapsed.map((entry, i) => (
                    <DropdownMenuItem
                      key={entry.id}
                      onClick={() => vault.navigateToBreadcrumb(i + 1)}
                      {...prefetchOn(entry)}
                    >
                      <FolderOpen className="text-info" aria-hidden="true" />
                      <span className="truncate">{entry.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </BreadcrumbItem>
          </>
        )}

        {parent && (
          <>
            {separator}
            <BreadcrumbItem {...dropTarget(parent)}>
              <BreadcrumbLink
                href={hrefFor(parent)}
                onClick={navigateOnClick(items.length - 2)}
                className="block max-w-24 truncate font-normal text-muted-foreground sm:max-w-40"
                title={parent.name}
                {...prefetchOn(parent)}
              >
                {parent.name}
              </BreadcrumbLink>
            </BreadcrumbItem>
          </>
        )}

        {separator}
        <BreadcrumbItem className="min-w-0">
          <h1
            aria-current="page"
            className="flex min-w-0 items-center gap-2 font-bold text-foreground"
            title={current.name}
          >
            <FolderOpen className="size-5 shrink-0 text-info" aria-hidden="true" />
            <span className="truncate">{current.name}</span>
          </h1>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
