"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRealtimeTable } from "@/hooks/use-realtime-table";
import { useTenantUser } from "@/components/providers/tenant-provider";
import type { PartWhereUsed } from "@/lib/where-used";
import {
  Plus,
  Search,
  Loader2,
  Package,
  MoreHorizontal,
  Pencil,
  Trash2,
  Upload,
  Download,
} from "lucide-react";
import { toast } from "sonner";
import type { Part, PartDetail } from "./parts-types";
import { CATEGORIES, categoryVariants } from "./parts-types";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { PartDetailPanel } from "./components/part-detail-panel";
import { PartFormDialog } from "./components/part-form-dialog";
import { AddVendorDialog } from "./components/add-vendor-dialog";
import { LinkFileDialog } from "./components/link-file-dialog";
import { FilePreviewDialog } from "./components/file-preview-dialog";
import { ImportResultsDialog } from "./components/import-results-dialog";
import { PageHeader } from "@/components/ui/page-header";
import { PageContainer } from "@/components/ui/page-container";

// --- Helpers ---

function useDebounce<T extends (...args: Parameters<T>) => void>(fn: T, delay: number): T {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return useCallback(
    (...args: Parameters<T>) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => fn(...args), delay);
    },
    [fn, delay]
  ) as T;
}

// --- Component ---

export default function PartsPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const user = useTenantUser();
  const [parts, setParts] = useState<Part[]>([]);
  const [loading, setLoading] = useState(true);
  const [partNumberMode, setPartNumberMode] = useState<"AUTO" | "MANUAL">("AUTO");
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");

  // Detail panel
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PartDetail | null>(null);
  const [partWhereUsed, setPartWhereUsed] = useState<PartWhereUsed | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // CSV import
  const csvImportRef = useRef<HTMLInputElement>(null);
  const [importingCsv, setImportingCsv] = useState(false);
  const [importResult, setImportResult] = useState<{
    inserted: number;
    updated: number;
    failed: number;
    total: number;
    results: {
      row: number;
      partNumber: string;
      action: "inserted" | "updated" | "failed";
      error?: string;
    }[];
  } | null>(null);

  // Dialogs
  const [showCreate, setShowCreate] = useState(false);
  const [editingPart, setEditingPart] = useState<Part | null>(null);
  const [showAddVendor, setShowAddVendor] = useState(false);
  const [showLinkFile, setShowLinkFile] = useState(false);
  const [previewFile, setPreviewFile] = useState<{ id: string; name: string } | null>(null);

  // --- Data loading ---

  const loadParts = useCallback(async (q?: string, cat?: string, st?: string) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (cat && cat !== "all") params.set("category", cat);
    if (st && st !== "all") params.set("state", st);
    const res = await fetch(`/api/parts?${params}`);
    const data = await res.json();
    setParts(Array.isArray(data) ? data : []);
    setLoading(false);
  }, []);

  /**
   * Clearing the selection also clears the deep-link param, so closing the
   * sheet and then reloading does not reopen it.
   */
  const closeDetail = useCallback(() => {
    setSelectedPartId(null);
    setDetail(null);
    setPartWhereUsed(null);
    router.replace("/parts", { scroll: false });
  }, [router]);

  const loadPartDetail = useCallback(async (partId: string) => {
    setSelectedPartId(partId);
    setLoadingDetail(true);
    const [detailRes, whereUsedRes] = await Promise.all([
      fetch(`/api/parts/${partId}`),
      fetch(`/api/parts/${partId}/where-used`),
    ]);
    const [detailData, whereUsedData] = await Promise.all([detailRes.json(), whereUsedRes.json()]);
    setDetail(detailData);
    setPartWhereUsed(whereUsedRes.ok ? whereUsedData : null);
    setLoadingDetail(false);
  }, []);

  useEffect(() => {
    void (async () => {
      await loadParts();
    })();
  }, [loadParts]);

  // Realtime
  useRealtimeTable({
    table: "parts",
    filter: `tenantId=eq.${user.tenantId}`,
    onChange: () => {
      void loadParts(searchQuery, categoryFilter, stateFilter);
      if (selectedPartId) void loadPartDetail(selectedPartId);
    },
  });
  useRealtimeTable({
    table: "eco_items",
    onChange: () => {
      if (selectedPartId) void loadPartDetail(selectedPartId);
    },
    enabled: !!selectedPartId,
  });
  useRealtimeTable({
    table: "bom_items",
    onChange: () => {
      if (selectedPartId) void loadPartDetail(selectedPartId);
    },
    enabled: !!selectedPartId,
  });

  // Fetch tenant part number mode
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/settings");
        if (!res.ok) return;
        const data = await res.json();
        const mode = data?.settings?.partNumberMode;
        if (mode === "MANUAL") setPartNumberMode("MANUAL");
      } catch {
        /* keep AUTO default */
      }
    })();
  }, []);

  // Auto-select part from URL query param
  useEffect(() => {
    const partId = searchParams.get("partId");
    if (!partId || parts.length === 0 || selectedPartId) return;
    if (!parts.some((p) => p.id === partId)) return;
    void (async () => {
      await loadPartDetail(partId);
    })();
  }, [parts, searchParams, selectedPartId, loadPartDetail]);

  const debouncedSearch = useDebounce((q: string) => {
    loadParts(q, categoryFilter, stateFilter);
  }, 300);

  function handleSearchInput(q: string) {
    setSearchQuery(q);
    debouncedSearch(q);
  }

  function handleFilterChange(cat: string, st: string) {
    setCategoryFilter(cat);
    setStateFilter(st);
    loadParts(searchQuery, cat, st);
  }

  // --- Actions ---

  function openCreateDialog() {
    setEditingPart(null);
    setShowCreate(true);
  }

  function openEditDialog(part: Part) {
    setEditingPart(part);
    setShowCreate(true);
  }

  async function handleDeletePart(partId: string) {
    const res = await fetch(`/api/parts/${partId}`, { method: "DELETE" });
    if (!res.ok) {
      const d = await res.json();
      toast.error(d.error);
      return;
    }
    toast.success("Part deleted");
    if (selectedPartId === partId) {
      setSelectedPartId(null);
      setDetail(null);
      setPartWhereUsed(null);
    }
    loadParts(searchQuery, categoryFilter, stateFilter);
  }

  async function handleDeleteVendorLink(linkId: string) {
    if (!selectedPartId) return;
    await fetch(`/api/parts/${selectedPartId}/vendors`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendorId: linkId }),
    });
    toast.success("Vendor removed");
    loadPartDetail(selectedPartId);
  }

  async function handleUnlinkFile(fileId: string) {
    if (!selectedPartId) return;
    await fetch(`/api/parts/${selectedPartId}/files`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId }),
    });
    toast.success("File unlinked");
    loadPartDetail(selectedPartId);
  }

  async function handleThumbnailUpload(e: React.ChangeEvent<HTMLInputElement>) {
    if (!selectedPartId || !e.target.files?.[0]) return;
    const file = e.target.files[0];
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/api/parts/${selectedPartId}/thumbnail`, { method: "POST", body: fd });
    if (res.ok) {
      toast.success("Thumbnail updated");
      loadPartDetail(selectedPartId);
      loadParts(searchQuery, categoryFilter, stateFilter);
    } else {
      const d = await res.json().catch(() => ({}));
      toast.error(d.error || "Thumbnail upload failed");
    }
    e.target.value = "";
  }

  function handleExportCsv() {
    const params = new URLSearchParams();
    if (searchQuery) params.set("q", searchQuery);
    if (categoryFilter && categoryFilter !== "all") params.set("category", categoryFilter);
    if (stateFilter && stateFilter !== "all") params.set("state", stateFilter);
    const qs = params.toString();
    window.open(`/api/parts/export${qs ? `?${qs}` : ""}`, "_blank");
  }

  async function handleImportCsv(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportingCsv(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/parts/import", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Import failed");
        return;
      }
      setImportResult(data);
      const summary = `${data.inserted} added, ${data.updated} updated${data.failed ? `, ${data.failed} failed` : ""}`;
      if (data.failed > 0) {
        toast.warning(summary);
      } else {
        toast.success(summary);
      }
      loadParts(searchQuery, categoryFilter, stateFilter);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImportingCsv(false);
      if (csvImportRef.current) csvImportRef.current.value = "";
    }
  }

  // --- Render ---

  return (
    <PageContainer>
      <PageHeader
        title="Parts Library"
        actions={
          <>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleExportCsv}>
                <Download className="w-4 h-4 mr-1.5" />
                <span className="hidden sm:inline">Export CSV</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => csvImportRef.current?.click()}
                disabled={importingCsv}
              >
                {importingCsv ? (
                  <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4 mr-1.5" />
                )}
                <span className="hidden sm:inline">Import CSV</span>
              </Button>
              <input
                ref={csvImportRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={handleImportCsv}
              />
              <Button size="sm" onClick={openCreateDialog}>
                <Plus className="w-4 h-4 mr-2" />
                New Part
              </Button>
            </div>
          </>
        }
      />

      {/* Search and filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => handleSearchInput(e.target.value)}
            placeholder="Search by part number, name, or description..."
            className="pl-8"
          />
        </div>
        <Select
          value={categoryFilter}
          onValueChange={(v) => handleFilterChange(v ?? "all", stateFilter)}
        >
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue placeholder="Category">
              {(v) =>
                v === "all"
                  ? "All Categories"
                  : (CATEGORIES.find((c) => c.value === v)?.label ?? "Category")
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {CATEGORIES.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={stateFilter}
          onValueChange={(v) => handleFilterChange(categoryFilter, v ?? "all")}
        >
          <SelectTrigger className="w-full sm:w-36">
            <SelectValue placeholder="State">{(v) => (v === "all" ? "All States" : v)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All States</SelectItem>
            <SelectItem value="WIP">WIP</SelectItem>
            <SelectItem value="In Review">In Review</SelectItem>
            <SelectItem value="Released">Released</SelectItem>
            <SelectItem value="Obsolete">Obsolete</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="flex gap-4 flex-col lg:flex-row">
          {/* Parts table. Full width always now — the detail is a sheet. */}
          <div className="flex-1 min-w-0">
            {parts.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <Package className="w-10 h-10 mx-auto mb-3 text-muted-foreground/30" />
                  <p className="text-muted-foreground">
                    {searchQuery || categoryFilter !== "all" || stateFilter !== "all"
                      ? "No parts match your search."
                      : 'No parts yet. Click "New Part" to add one.'}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="border rounded-lg bg-background overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10"></TableHead>
                      <TableHead>Part #</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead>Cost</TableHead>
                      <TableHead className="w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {parts.map((part) => (
                      <TableRow
                        key={part.id}
                        className={`cursor-pointer ${selectedPartId === part.id ? "bg-muted/50" : ""}`}
                        onClick={() => loadPartDetail(part.id)}
                      >
                        <TableCell>
                          {part.thumbnailUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={part.thumbnailUrl}
                              alt=""
                              className="w-8 h-8 rounded object-cover"
                            />
                          ) : (
                            <div className="w-8 h-8 rounded bg-muted flex items-center justify-center">
                              <Package className="w-3.5 h-3.5 text-muted-foreground/40" />
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-sm">{part.partNumber}</TableCell>
                        <TableCell className="font-medium text-sm">{part.name}</TableCell>
                        <TableCell>
                          <Badge
                            variant={categoryVariants[part.category] || "secondary"}
                            className="text-3xs"
                          >
                            {CATEGORIES.find((c) => c.value === part.category)?.label ||
                              part.category}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <StatusBadge
                            status={part.lifecycleState}
                            kind="lifecycle"
                            className="text-3xs"
                          />
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {part.unitCost != null ? `$${part.unitCost.toFixed(2)}` : "—"}
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <Button variant="ghost" size="icon-xs">
                                  <MoreHorizontal className="w-3.5 h-3.5" />
                                </Button>
                              }
                            />
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => openEditDialog(part)}>
                                <Pencil className="w-3.5 h-3.5 mr-2" /> Edit
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-destructive"
                                onClick={() => handleDeletePart(part.id)}
                              >
                                <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>

          {/*
            Detail is a slide-over rather than a column, for two reasons.

            It was in document flow at the top of this row, so selecting a
            part forty rows down rendered the panel above the viewport and
            the page just looked blank. A sheet is anchored to the viewport,
            so it opens where you are looking regardless of scroll.

            And it was `lg:w-80` beside a full-width table — 20rem for a
            header, revision, unit, files, vendors and where-used, with BOM
            names truncated to "NANO-1000S Casting-C...". The sheet gives it
            more than twice that.

            The vault already uses Sheet for its mobile detail view, so this
            is the app's existing answer to the same problem rather than a
            new pattern.
          */}
          <Sheet
            open={!!selectedPartId}
            onOpenChange={(open) => {
              if (!open) closeDetail();
            }}
          >
            <SheetContent side="right" className="w-full p-0 sm:max-w-2xl!" showCloseButton={false}>
              <SheetTitle className="sr-only">
                {detail?.partNumber ? `Part ${detail.partNumber}` : "Part details"}
              </SheetTitle>
              <ErrorBoundary>
                <PartDetailPanel
                  detail={detail}
                  loading={loadingDetail}
                  partWhereUsed={partWhereUsed}
                  onClose={closeDetail}
                  onThumbnailUpload={handleThumbnailUpload}
                  onShowLinkFile={() => setShowLinkFile(true)}
                  onShowAddVendor={() => setShowAddVendor(true)}
                  onUnlinkFile={handleUnlinkFile}
                  onDeleteVendorLink={handleDeleteVendorLink}
                  onPreviewFile={setPreviewFile}
                  onNavigatePartDetail={loadPartDetail}
                />
              </ErrorBoundary>
            </SheetContent>
          </Sheet>
        </div>
      )}

      {/* Dialogs */}
      <PartFormDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        editingPart={editingPart}
        partNumberMode={partNumberMode}
        onSaved={() => {
          loadParts(searchQuery, categoryFilter, stateFilter);
          if (editingPart && selectedPartId === editingPart.id) loadPartDetail(editingPart.id);
        }}
      />

      {selectedPartId && (
        <>
          <AddVendorDialog
            open={showAddVendor}
            onOpenChange={setShowAddVendor}
            partId={selectedPartId}
            onAdded={() => loadPartDetail(selectedPartId)}
          />
          <LinkFileDialog
            open={showLinkFile}
            onOpenChange={setShowLinkFile}
            partId={selectedPartId}
            hasExistingFiles={(detail?.files.length ?? 0) > 0}
            onLinked={() => loadPartDetail(selectedPartId)}
          />
        </>
      )}

      <FilePreviewDialog file={previewFile} onClose={() => setPreviewFile(null)} />
      <ImportResultsDialog result={importResult} onClose={() => setImportResult(null)} />
    </PageContainer>
  );
}
