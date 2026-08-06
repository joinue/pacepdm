"use client";

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useFetch } from "@/hooks/use-fetch";
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
import { useRealtimeEchoGuard } from "@/hooks/use-realtime-echo-guard";
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
import { fetchJson, errorMessage, uploadFile } from "@/lib/api-client";
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
import { EntityThumbnail } from "@/components/ui/entity-thumbnail";
import { PageHeader } from "@/components/ui/page-header";
import { PageContainer } from "@/components/ui/page-container";

// --- Component ---

export default function PartsPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  /** Monotonic id for detail fetches; only the latest may write state. */
  const detailRequestSeq = useRef(0);
  const user = useTenantUser();
  const [partNumberMode, setPartNumberMode] = useState<"AUTO" | "MANUAL">("AUTO");
  // OPEN unless the tenant has a connected source of cost truth. Only a UI
  // affordance — the parts route enforces it. See lib/cost-source.ts.
  const [costSource, setCostSource] = useState<"OPEN" | "LOCKED">("OPEN");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
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
    warned: number;
    total: number;
    results: {
      row: number;
      partNumber: string;
      action: "inserted" | "updated" | "failed";
      error?: string;
      warning?: string;
    }[];
  } | null>(null);

  // Dialogs
  const [showCreate, setShowCreate] = useState(false);
  const [editingPart, setEditingPart] = useState<Part | null>(null);
  const [showAddVendor, setShowAddVendor] = useState(false);
  const [showLinkFile, setShowLinkFile] = useState(false);
  const [previewFile, setPreviewFile] = useState<{ id: string; name: string } | null>(null);

  // --- Data loading ---

  // Search and filters drive the URL, and the URL drives the fetch — so
  // changing either is a single state update rather than a hand-sequenced
  // reload, and switching filters quickly aborts the superseded request
  // instead of racing it.
  const partsUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedQuery) params.set("q", debouncedQuery);
    if (categoryFilter !== "all") params.set("category", categoryFilter);
    if (stateFilter !== "all") params.set("state", stateFilter);
    const qs = params.toString();
    return `/api/parts${qs ? `?${qs}` : ""}`;
  }, [debouncedQuery, categoryFilter, stateFilter]);

  const {
    data: partsData,
    loading,
    error: partsError,
    refetch: loadParts,
  } = useFetch<Part[]>(partsUrl);
  // Memoised because the deep-link effect below depends on it — a fresh []
  // each render would re-run that effect forever.
  const parts = useMemo(() => partsData ?? [], [partsData]);

  // Realtime on `parts` replays this tab's own writes. Mutations reload
  // through `reloadParts`, which marks the write so the echo is ignored.
  const { markLocalWrite, isEcho } = useRealtimeEchoGuard();
  const reloadParts = useCallback(() => {
    markLocalWrite();
    return loadParts();
  }, [markLocalWrite, loadParts]);

  /**
   * Clearing the selection also clears the deep-link param, so closing the
   * sheet and then reloading does not reopen it.
   */
  const closeDetail = useCallback(() => {
    setSelectedPartId(null);
    setDetail(null);
    setPartWhereUsed(null);
    // lint-conventions-allow: list-route-navigation — this CLEARS the
    // ?partId= deep link on close, which is the opposite of dropping an id.
    router.replace("/parts", { scroll: false });
  }, [router]);

  /**
   * Designate the part as an end item, or take the designation away. Written
   * to the part rather than to any BOM: the fact is about the item, and a
   * part can be sellable without having a bill of materials at all — the
   * polishing wheels sold with the NANO-1000S are exactly that.
   */
  const handleToggleEndItem = useCallback(
    async (isEndItem: boolean) => {
      if (!selectedPartId) return;
      try {
        const updated = await fetchJson<{ isEndItem: boolean }>(`/api/parts/${selectedPartId}`, {
          method: "PUT",
          body: { isEndItem },
        });
        // Trust the row the server wrote, not the value we sent — and bump
        // the sequence so a detail fetch already in flight cannot overwrite
        // it with a pre-write snapshot.
        detailRequestSeq.current++;
        setDetail((prev) => (prev ? { ...prev, isEndItem: updated.isEndItem } : prev));
        toast.success(updated.isEndItem ? "Marked as an end item" : "No longer an end item");
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },
    [selectedPartId]
  );

  /**
   * Load a part's detail, ignoring any response that has been overtaken.
   *
   * Three realtime subscriptions call this, and one of them fires on the
   * very write the user just made — so a fetch can start BEFORE that write
   * commits and land AFTER the UI has already shown the new value, silently
   * reverting it. That is what made the End item checkbox tick and then
   * immediately untick.
   *
   * The sequence number is the same guard `useVaultContents` uses for the
   * same reason: only the most recently issued request may write state.
   */
  const loadPartDetail = useCallback(async (partId: string) => {
    const seq = ++detailRequestSeq.current;
    const isCurrent = () => detailRequestSeq.current === seq;

    setSelectedPartId(partId);
    setLoadingDetail(true);
    try {
      const [detailData, whereUsedData] = await Promise.all([
        fetchJson<PartDetail>(`/api/parts/${partId}`),
        fetchJson<PartWhereUsed>(`/api/parts/${partId}/where-used`).catch(() => null),
      ]);
      if (!isCurrent()) return;
      setDetail(detailData);
      setPartWhereUsed(whereUsedData);
    } catch (err) {
      if (!isCurrent()) return;
      toast.error(errorMessage(err));
    } finally {
      if (isCurrent()) setLoadingDetail(false);
    }
  }, []);

  // Realtime
  // Skip the replay of this tab's own writes — every mutation here already
  // reloads explicitly, so acting on the echo would fetch the list twice.
  useRealtimeTable({
    table: "parts",
    filter: `tenantId=eq.${user.tenantId}`,
    onChange: () => {
      if (isEcho()) return;
      void loadParts();
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

  // Tenant part-number mode. A failure here is non-fatal — the form falls
  // back to AUTO — so this read deliberately does not surface an error.
  const { data: settingsData } = useFetch<{
    settings?: { partNumberMode?: string; costSource?: string };
  }>("/api/settings");
  useEffect(() => {
    if (settingsData?.settings?.partNumberMode === "MANUAL") setPartNumberMode("MANUAL");
    if (settingsData?.settings?.costSource === "LOCKED") setCostSource("LOCKED");
  }, [settingsData]);

  // Auto-select part from URL query param
  useEffect(() => {
    const partId = searchParams.get("partId");
    if (!partId || parts.length === 0 || selectedPartId) return;
    if (!parts.some((p) => p.id === partId)) return;
    void (async () => {
      await loadPartDetail(partId);
    })();
  }, [parts, searchParams, selectedPartId, loadPartDetail]);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(searchQuery), 300);
    return () => clearTimeout(id);
  }, [searchQuery]);

  function handleSearchInput(q: string) {
    setSearchQuery(q);
  }

  function handleFilterChange(cat: string, st: string) {
    setCategoryFilter(cat);
    setStateFilter(st);
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
    try {
      await fetchJson(`/api/parts/${partId}`, { method: "DELETE" });
      toast.success("Part deleted");
      if (selectedPartId === partId) {
        setSelectedPartId(null);
        setDetail(null);
        setPartWhereUsed(null);
      }
      reloadParts();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function handleDeleteVendorLink(linkId: string) {
    if (!selectedPartId) return;
    try {
      await fetchJson(`/api/parts/${selectedPartId}/vendors`, {
        method: "DELETE",
        body: { vendorId: linkId },
      });
      toast.success("Vendor removed");
      loadPartDetail(selectedPartId);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function handleUnlinkFile(fileId: string) {
    if (!selectedPartId) return;
    try {
      await fetchJson(`/api/parts/${selectedPartId}/files`, {
        method: "DELETE",
        body: { fileId },
      });
      toast.success("File unlinked");
      loadPartDetail(selectedPartId);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function handleThumbnailUpload(file: File) {
    if (!selectedPartId) return;
    try {
      await uploadFile(`/api/parts/${selectedPartId}/thumbnail`, file);
      toast.success("Thumbnail updated");
      loadPartDetail(selectedPartId);
      reloadParts();
    } catch (err) {
      toast.error(errorMessage(err));
    }
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
      const summary =
        `${data.inserted} added, ${data.updated} updated` +
        `${data.failed ? `, ${data.failed} failed` : ""}` +
        `${data.warned ? `, ${data.warned} with warnings` : ""}`;
      // A warning still opens the results dialog, but it is not a failure —
      // the rows landed. Only the toast tone differs.
      if (data.failed > 0 || data.warned > 0) {
        toast.warning(summary);
      } else {
        toast.success(summary);
      }
      reloadParts();
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
      ) : partsError ? (
        <Card>
          <CardContent className="py-12 text-center text-destructive text-sm">
            {errorMessage(partsError)}
          </CardContent>
        </Card>
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
                          <EntityThumbnail src={part.thumbnailUrl} kind="part" size="sm" />
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
                  onToggleEndItem={handleToggleEndItem}
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
        costSource={costSource}
        onSaved={() => {
          reloadParts();
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
