"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  FolderPlus, Upload, Download, Trash2, Search,
} from "lucide-react";
import type { VaultBrowserState } from "@/hooks/use-vault-browser";

interface VaultToolbarProps {
  vault: VaultBrowserState;
}

export function VaultToolbar({ vault }: VaultToolbarProps) {
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold">Vault</h2>
          <VaultBreadcrumbs vault={vault} />
        </div>
        <div className="flex gap-2 flex-wrap">
          {vault.selectedFiles.size > 0 && (
            <>
              <Button variant="outline" size="sm" onClick={vault.handleBulkDownload} disabled={vault.bulkDownloading}>
                <Download className="w-4 h-4 sm:mr-1" />
                <span className="hidden sm:inline">
                  {vault.bulkDownloading ? "Zipping..." : `Download (${vault.selectedFiles.size})`}
                </span>
              </Button>
              <Button variant="destructive" size="sm" onClick={() => vault.setShowBulkDeleteConfirm(true)}>
                <Trash2 className="w-4 h-4 sm:mr-1" />
                <span className="hidden sm:inline">Delete ({vault.selectedFiles.size})</span>
              </Button>
            </>
          )}
          <Button variant="outline" size="sm" onClick={() => vault.setShowCreateFolder(true)}>
            <FolderPlus className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">New Folder</span>
          </Button>
          <Button size="sm" onClick={() => vault.setShowUpload(true)}>
            <Upload className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Upload</span>
          </Button>
        </div>
      </div>

      {/* Search & Filter */}
      {!vault.selectedFile && (
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
            <Select value={vault.filterState} onValueChange={(v) => vault.setFilterState(v ?? "all")}>
              <SelectTrigger className="w-full sm:w-40 h-9">
                <SelectValue placeholder="All states" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All states</SelectItem>
                {vault.lifecycleStates.map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}
    </div>
  );
}

function VaultBreadcrumbs({ vault }: VaultToolbarProps) {
  return (
    <Breadcrumb className="mt-1">
      <BreadcrumbList>
        {vault.breadcrumbs.map((entry, i) => (
          <React.Fragment key={entry.id}>
            {i > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem
              onDragOver={(e) => { if (entry.id !== vault.currentFolderId) vault.handleDragOver(e, entry.id); }}
              onDragLeave={vault.handleDragLeave}
              onDrop={(e) => { if (entry.id !== vault.currentFolderId) vault.handleDrop(e, entry.id); }}
              className={vault.dropTargetId === entry.id ? "ring-2 ring-primary rounded px-1" : ""}
            >
              <BreadcrumbLink onClick={() => vault.navigateToBreadcrumb(i)} className="cursor-pointer text-xs sm:text-sm">
                {entry.name}
              </BreadcrumbLink>
            </BreadcrumbItem>
          </React.Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
