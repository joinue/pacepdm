"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Plus,
  Download,
  Upload,
  Trash2,
  Package,
  Loader2,
  MoreHorizontal,
  Pencil,
  Check,
  ChevronDown,
  X,
  ArrowRight,
  Link as LinkIcon,
  TriangleAlert,
  ChevronRight,
} from "lucide-react";
import { ShareDialog } from "@/components/share/share-dialog";
import { toast } from "sonner";
import { BOM_STATUS_FLOW } from "@/lib/status-flows";
import { fetchJson, errorMessage } from "@/lib/api-client";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/lib/permissions";
import { useNotifications } from "@/components/providers/notification-provider";

import type { BOM, BOMItem } from "./types";
import { statusLabels } from "./constants";
import { CreateBomDialog } from "./components/create-bom-dialog";
import { ImportBomDialog } from "./components/import-bom-dialog";
import { CompareBomDialog } from "./components/compare-bom-dialog";
import { AddItemDialog } from "./components/add-item-dialog";
import { BomItemsTable } from "./components/bom-items-table";
import { BomRollupPanel } from "./components/bom-rollup-panel";
import { BomBaselinesPanel } from "./components/bom-baselines-panel";
import { PageHeader } from "@/components/ui/page-header";
import { SectionLabel } from "@/components/ui/section-label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buildBomTree, visibleRows, type BomTreeNode } from "./bom-hierarchy";
import { PageContainer } from "@/components/ui/page-container";

/**
 * BOMs view — list + optional detail. The currently-selected BOM lives in
 * the URL path (/boms/[bomId]), not in local state, so every BOM has a
 * shareable, bookmarkable URL and browser back/forward works naturally.
 *
 * This component is rendered by both:
 *   /boms              → no selection (shows the list)
 *   /boms/[bomId]      → detail for one BOM alongside the list
 *
 * Each route passes `selectedBomId` down. Clicking a BOM in the sidebar
 * calls `router.push("/boms/${id}")` — the URL change re-renders this
 * component with a new prop, which triggers the items fetch.
 */
export function BomsView({ selectedBomId }: { selectedBomId: string | null }) {
  const router = useRouter();
  const { can } = usePermissions();
  const canEdit = can(PERMISSIONS.FILE_EDIT);
  const canShare = can(PERMISSIONS.SHARE_CREATE);
  const { clearRef, counts: notificationCounts } = useNotifications();

  // When the user opens a specific BOM, auto-clear any unread notifications
  // that referenced it. Keeps the sidebar badge honest: navigating *into*
  // the entity is just as valid a "I saw it" signal as clicking the bell.
  useEffect(() => {
    if (selectedBomId) void clearRef(selectedBomId);
  }, [selectedBomId, clearRef]);

  // Per-BOM unread counts so each list row can show its own badge. Refetched
  // whenever the top-level counts change (sidebar badge delta is our signal
  // that *something* in /boms became or stopped being unread).
  const [bomUnread, setBomUnread] = useState<Record<string, number>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/notifications/counts-by-ref?prefix=/boms/");
        if (!r.ok) return;
        const data = (await r.json()) as { counts: Record<string, number> };
        if (!cancelled) setBomUnread(data.counts || {});
      } catch (err) {
        console.error("[boms] per-bom notif counts failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notificationCounts.byCategory.boms]);

  const [boms, setBoms] = useState<BOM[]>([]);
  const [relinkingId, setRelinkingId] = useState<string | null>(null);
  // The BOM tree, derived from `usedIn` — which the list endpoint computes
  // from `bom_items.linkedBomId`. The shape therefore follows the real
  // structure and cannot drift from it.
  const tree = useMemo(() => buildBomTree(boms), [boms]);
  // Collapsed by default: one machine brings 25 sub-assemblies, and the
  // point of the tree is that you only open the branch you care about.
  const [expandedBoms, setExpandedBoms] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<BOM | null>(null);
  const [items, setItems] = useState<BOMItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);

  // Dialog visibility
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showAddItem, setShowAddItem] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  const [showShare, setShowShare] = useState(false);

  // Inline rename
  const [renamingBom, setRenamingBom] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // ─── Loaders ─────────────────────────────────────────────────────────
  const loadBoms = useCallback(async () => {
    try {
      const data = await fetchJson<BOM[]>("/api/boms");
      setBoms(Array.isArray(data) ? data : []);
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to load BOMs");
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Repair a sub-assembly link broken by a typo in the source data. The
   * server decides what is safe to relink — this only asks. Reloading the
   * list is what moves the BOM out of Products and into Sub-assemblies.
   */
  const handleRelink = useCallback(
    async (bom: BOM) => {
      setRelinkingId(bom.id);
      try {
        const result = await fetchJson<{
          repaired: { bomName: string }[];
          orphanedParts: string[];
        }>(`/api/boms/${bom.id}/relink`, { method: "POST" });

        const parents = [...new Set(result.repaired.map((r) => r.bomName))];
        toast.success(`Linked ${bom.name} into ${parents.join(", ")}`, {
          description: result.orphanedParts.length
            ? `"${result.orphanedParts.join('", "')}" is no longer referenced by any BOM — you may want to delete it from Parts.`
            : undefined,
        });
        await loadBoms();
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        setRelinkingId(null);
      }
    },
    [loadBoms]
  );

  const toggleExpanded = useCallback((bomId: string) => {
    setExpandedBoms((prev) => {
      const next = new Set(prev);
      if (next.has(bomId)) next.delete(bomId);
      else next.add(bomId);
      return next;
    });
  }, []);

  /** Open every branch, or shut them all. One control, two states. */
  const toggleExpandAll = useCallback(() => {
    setExpandedBoms((prev) => (prev.size > 0 ? new Set() : new Set(boms.map((b) => b.id))));
  }, [boms]);

  /**
   * Deleting is one click from the row now, so it goes through a confirm.
   * Soft-delete means it is recoverable in the database, but there is no
   * trash for BOMs yet, so from the UI it is one-way.
   */
  const requestDeleteBom = useCallback((bom: BOM) => setDeleteTarget(bom), []);

  const loadItems = useCallback(async (bomId: string) => {
    setLoadingItems(true);
    try {
      const data = await fetchJson<BOMItem[]>(`/api/boms/${bomId}/items`);
      setItems(Array.isArray(data) ? data : []);
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to load BOM items");
    } finally {
      setLoadingItems(false);
    }
  }, []);

  // Convenience: refresh items for the currently selected BOM
  const refreshItems = useCallback(() => {
    if (selectedBomId) loadItems(selectedBomId);
  }, [selectedBomId, loadItems]);

  // Load the BOM list once on mount
  useEffect(() => {
    void (async () => {
      await loadBoms();
    })();
  }, [loadBoms]);

  // Load items whenever the selected BOM (from the URL) changes. Unlike
  // the previous version, selection is NOT local state — it comes from
  // the route param, so this effect is the one place that reacts to it.
  useEffect(() => {
    if (!selectedBomId) {
      setItems([]);
      return;
    }
    void loadItems(selectedBomId);
  }, [selectedBomId, loadItems]);

  // Navigate to a BOM's dedicated URL. The re-render from the route
  // change is what triggers the items load above.
  const selectBom = useCallback(
    (bomId: string) => {
      router.push(`/boms/${bomId}`);
    },
    [router]
  );

  const clearSelection = useCallback(() => {
    // lint-conventions-allow: list-route-navigation — deselecting IS a
    // return to the index; there is no record to link to.
    router.push("/boms");
  }, [router]);

  // ─── BOM-level mutations ─────────────────────────────────────────────
  async function handleStatusChange(bomId: string, newStatus: string) {
    try {
      await fetchJson(`/api/boms/${bomId}`, {
        method: "PUT",
        body: { status: newStatus },
      });
      toast.success(`Status changed to ${statusLabels[newStatus] || newStatus}`);
      loadBoms();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function handleRenameBom(bomId: string) {
    if (!renameValue.trim()) return;
    try {
      await fetchJson(`/api/boms/${bomId}`, {
        method: "PUT",
        body: { name: renameValue.trim() },
      });
      toast.success("BOM renamed");
      setRenamingBom(null);
      setRenameValue("");
      loadBoms();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function handleDeleteBom(bomId: string) {
    try {
      await fetchJson(`/api/boms/${bomId}`, { method: "DELETE" });
      toast.success("BOM deleted");
      // If we deleted the currently-viewed BOM, navigate back to the list.
      if (selectedBomId === bomId) {
        clearSelection();
      }
      loadBoms();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  function handleExport(bomId: string) {
    window.open(`/api/boms/${bomId}/export`, "_blank");
  }

  // ─── CSV import (uses the bulk endpoint added in migration round) ────
  async function handleCsvImport(e: React.ChangeEvent<HTMLInputElement>) {
    if (!selectedBomId || !e.target.files?.[0]) return;
    const file = e.target.files[0];
    const text = await file.text();
    const lines = text.split("\n").filter((l) => l.trim());
    if (lines.length < 2) {
      toast.error("CSV must have a header row and at least one data row");
      return;
    }

    const headers = lines[0].split(",").map((h) => h.replace(/"/g, "").trim().toLowerCase());
    const itemNumIdx = headers.findIndex((h) => h.includes("item"));
    const pnIdx = headers.findIndex((h) => h.includes("part") && h.includes("num"));
    const nameIdx = headers.findIndex((h) => h === "name" || h.includes("description"));
    const qtyIdx = headers.findIndex((h) => h.includes("qty") || h.includes("quantity"));
    const unitIdx = headers.findIndex((h) => h.includes("unit"));
    const matIdx = headers.findIndex((h) => h.includes("material"));
    const vendorIdx = headers.findIndex((h) => h.includes("vendor"));
    const costIdx = headers.findIndex((h) => h.includes("cost"));

    if (nameIdx === -1) {
      toast.error("CSV must have a 'Name' column");
      return;
    }

    // Parse all rows up-front, then send in a single batch request.
    const rowsToImport: Record<string, unknown>[] = [];
    let skipped = 0;
    for (let i = 1; i < lines.length; i++) {
      const cols =
        lines[i]
          .match(/(".*?"|[^",]+|(?<=,)(?=,)|(?<=,)$)/g)
          ?.map((c) => c.replace(/^"|"$/g, "").trim()) || [];
      const name = cols[nameIdx];
      if (!name) {
        skipped++;
        continue;
      }
      rowsToImport.push({
        itemNumber:
          cols[itemNumIdx] || String(items.length + rowsToImport.length + 1).padStart(3, "0"),
        partNumber: pnIdx >= 0 ? cols[pnIdx] || null : null,
        name,
        quantity: qtyIdx >= 0 ? parseFloat(cols[qtyIdx]) || 1 : 1,
        unit: unitIdx >= 0 ? cols[unitIdx] || "EA" : "EA",
        material: matIdx >= 0 ? cols[matIdx] || null : null,
        vendor: vendorIdx >= 0 ? cols[vendorIdx] || null : null,
        unitCost: costIdx >= 0 ? parseFloat(cols[costIdx]) || null : null,
        sortOrder: items.length + rowsToImport.length,
      });
    }

    if (rowsToImport.length === 0) {
      toast.error("No valid rows to import");
      e.target.value = "";
      return;
    }

    try {
      const result = await fetchJson<{ inserted: number }>(`/api/boms/${selectedBomId}/items`, {
        method: "POST",
        body: { items: rowsToImport },
      });
      const summary = `Imported ${result.inserted} item${result.inserted !== 1 ? "s" : ""}`;
      toast.success(skipped > 0 ? `${summary} (${skipped} skipped — missing name)` : summary);
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to import CSV");
    }
    e.target.value = "";
    refreshItems();
  }

  // ─── Derived state ───────────────────────────────────────────────────
  const totalCost = items.reduce((sum, i) => sum + (i.unitCost || 0) * i.quantity, 0);
  const selectedBomData = boms.find((b) => b.id === selectedBomId);
  const isEditable =
    canEdit && (selectedBomData?.status === "DRAFT" || selectedBomData?.status === "IN_REVIEW");

  // The URL can point at a BOM that doesn't exist (stale bookmark, deleted
  // BOM, guessed id). Surface that once the list has loaded instead of
  // silently showing an empty detail panel.
  const selectionMissing = !loading && selectedBomId !== null && !selectedBomData;

  // Auto-generate next item number for the Add Item dialog
  function getNextItemNumber(): string {
    if (items.length === 0) return "001";
    const nums = items.map((i) => parseInt(i.itemNumber, 10)).filter((n) => !isNaN(n));
    const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
    return String(next).padStart(3, "0");
  }

  const handleBomCreated = useCallback(
    (created?: { id: string }) => {
      loadBoms();
      if (created?.id) selectBom(created.id);
    },
    [loadBoms, selectBom]
  );

  return (
    <PageContainer>
      <PageHeader
        title="Bill of Materials"
        actions={
          <>
            <div className="flex gap-2">
              {boms.length >= 2 && (
                <Button variant="outline" size="sm" onClick={() => setShowCompare(true)}>
                  Compare
                </Button>
              )}
              {canEdit && (
                <Button variant="outline" size="sm" onClick={() => setShowImport(true)}>
                  <Upload className="w-4 h-4 mr-2" />
                  Import
                </Button>
              )}
              {canEdit && (
                <Button size="sm" onClick={() => setShowCreate(true)}>
                  <Plus className="w-4 h-4 mr-2" />
                  New BOM
                </Button>
              )}
            </div>
          </>
        }
      />

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : boms.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Package className="w-10 h-10 mx-auto mb-3 text-muted-foreground/30" />
            <p className="text-muted-foreground">
              No BOMs yet. Click &ldquo;New BOM&rdquo; to create one.
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              A BOM is a list of parts and materials needed to build something.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex gap-4 flex-col lg:flex-row">
          {/*
            Two things the flat list got wrong once a real product landed.

            Layout: it was a fixed 14rem sidebar whether or not anything was
            selected, so browsing truncated every name while most of the page
            sat empty. Browse mode now takes the full width; selecting a BOM
            collapses it back to the sidebar it needs to be.

            Structure: 26 rows rendered identically when 25 of them are
            children of one machine. Products come first, sub-assemblies are
            grouped under their parent, and a link broken by a typo is called
            out rather than sitting among the products looking deliberate.
          */}
          <div
            className={selectedBomId ? "lg:w-64 shrink-0 space-y-2" : "flex-1 min-w-0 space-y-2"}
          >
            <div className="flex items-center justify-between gap-2">
              {/* Two sections, because they answer different questions.
                  "Products" is declared — someone marked the part an end
                  item. "Top level" is derived — nothing references it yet.
                  A draft BOM is the second and not the first, and the old
                  single "Products" label claimed otherwise. */}
              <SectionLabel>
                {tree.products.length > 0
                  ? `${tree.products.length} product${tree.products.length === 1 ? "" : "s"}`
                  : "Top level"}
                {tree.subAssemblyCount > 0 && ` · ${tree.subAssemblyCount} sub-assemblies`}
              </SectionLabel>
              {tree.subAssemblyCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-3xs text-muted-foreground"
                  onClick={toggleExpandAll}
                >
                  {expandedBoms.size > 0 ? "Collapse all" : "Expand all"}
                </Button>
              )}
            </div>

            {tree.products.length > 0 && tree.topLevel.length > 0 && (
              <p className="text-3xs text-muted-foreground pt-1">
                Products are parts marked as end items. Anything below is unreferenced but not
                designated.
              </p>
            )}

            {visibleRows(tree.roots, expandedBoms).map((node) => (
              <BomTreeRow
                key={`${node.bom.id}@${node.depth}`}
                node={node}
                compact={!!selectedBomId}
                expanded={expandedBoms.has(node.bom.id)}
                onToggle={() => toggleExpanded(node.bom.id)}
                selectedBomId={selectedBomId}
                unread={bomUnread[node.bom.id] || 0}
                onSelect={selectBom}
                canEdit={canEdit}
                relinkingId={relinkingId}
                onRelink={handleRelink}
                onDelete={requestDeleteBom}
              />
            ))}
          </div>

          {/* Selection points at a BOM that no longer exists */}
          {selectionMissing && (
            <div className="flex-1 min-w-0">
              <Card>
                <CardContent className="py-12 text-center space-y-3">
                  <Package className="w-10 h-10 mx-auto text-muted-foreground/30" />
                  <p className="text-muted-foreground">This BOM no longer exists.</p>
                  <Button variant="outline" size="sm" onClick={clearSelection}>
                    Back to BOM list
                  </Button>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Selected BOM detail */}
          {selectedBomId && selectedBomData && (
            <div className="flex-1 space-y-4 min-w-0">
              {/* Detail header */}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  {renamingBom === selectedBomId ? (
                    <div className="flex items-center gap-2">
                      <Input
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        className="h-8 text-lg font-semibold px-2 w-64"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleRenameBom(selectedBomId);
                          if (e.key === "Escape") setRenamingBom(null);
                        }}
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => handleRenameBom(selectedBomId)}
                      >
                        <Check className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="icon-sm" onClick={() => setRenamingBom(null)}>
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <h3 className="text-lg font-semibold truncate">{selectedBomData.name}</h3>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => {
                          setRenamingBom(selectedBomId);
                          setRenameValue(selectedBomData.name);
                        }}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <Pencil className="w-3 h-3" />
                      </Button>
                    </div>
                  )}
                  <div className="flex items-center gap-3 mt-1">
                    <StatusBadge status={selectedBomData.status} kind="bom" />
                    <span className="text-sm text-muted-foreground">
                      Rev {selectedBomData.revision} &middot; {items.length} item
                      {items.length !== 1 ? "s" : ""} &middot; ${totalCost.toFixed(2)}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {/* Status transitions. The current status is already shown
                      as a Badge in the header above, so the trigger is an
                      action-only "Change status" button — no duplication.
                      The `w-auto` class on the content breaks out of the
                      base component's `w-(--anchor-width)` sizing so the
                      menu fits its options instead of inheriting the
                      trigger width. */}
                  {(BOM_STATUS_FLOW[selectedBomData.status] || []).length > 0 && canEdit && (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button variant="outline" size="sm">
                            Change status
                            <ChevronDown className="w-3 h-3 ml-1" />
                          </Button>
                        }
                      />
                      <DropdownMenuContent align="end" className="w-auto min-w-44">
                        {(BOM_STATUS_FLOW[selectedBomData.status] || []).map((s) => (
                          <DropdownMenuItem
                            key={s}
                            onClick={() => handleStatusChange(selectedBomId, s)}
                            className="gap-2"
                          >
                            <ArrowRight className="w-3.5 h-3.5 text-muted-foreground" />
                            <span>Move to {statusLabels[s] || s}</span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  <Button variant="outline" size="sm" onClick={() => handleExport(selectedBomId)}>
                    <Download className="w-4 h-4 mr-1" />
                    <span className="hidden sm:inline">Export</span>
                  </Button>
                  {isEditable && (
                    <>
                      <label className="inline-flex items-center justify-center rounded-full border border-border bg-background hover:bg-muted text-sm font-medium h-8 gap-1.5 px-2.5 cursor-pointer transition-all">
                        <Upload className="w-4 h-4" />
                        <span className="hidden sm:inline">Import CSV</span>
                        <input
                          type="file"
                          accept=".csv"
                          className="hidden"
                          onChange={handleCsvImport}
                        />
                      </label>
                      <Button size="sm" onClick={() => setShowAddItem(true)}>
                        <Plus className="w-4 h-4 mr-1" />
                        <span className="hidden sm:inline">Add Item</span>
                      </Button>
                    </>
                  )}
                  {(canEdit || canShare) && (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button variant="ghost" size="icon-sm">
                            <MoreHorizontal className="w-4 h-4" />
                          </Button>
                        }
                      />
                      <DropdownMenuContent align="end">
                        {canShare && (
                          <DropdownMenuItem onClick={() => setShowShare(true)}>
                            <LinkIcon className="w-3.5 h-3.5 mr-2" /> Share link
                          </DropdownMenuItem>
                        )}
                        {canShare && canEdit && <DropdownMenuSeparator />}
                        {canEdit && (
                          <DropdownMenuItem
                            onClick={() => {
                              setRenamingBom(selectedBomId);
                              setRenameValue(selectedBomData.name);
                            }}
                          >
                            <Pencil className="w-3.5 h-3.5 mr-2" /> Rename
                          </DropdownMenuItem>
                        )}
                        {canEdit && <DropdownMenuSeparator />}
                        {canEdit && (
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => handleDeleteBom(selectedBomId)}
                            disabled={selectedBomData.status === "RELEASED"}
                          >
                            <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </div>

              {/* Items table */}
              {loadingItems ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <BomItemsTable
                  items={items}
                  bomId={selectedBomId}
                  isEditable={!!isEditable}
                  onItemsChanged={refreshItems}
                />
              )}

              {/* Cost summary — flat-only, see rollup panel below for sub-assembly totals */}
              {items.length > 0 && (
                <div className="flex justify-end text-sm">
                  <div className="bg-muted/50 rounded-lg px-4 py-2 text-right">
                    <span className="text-muted-foreground mr-3">
                      Flat total ({items.length} items)
                    </span>
                    <span className="font-mono font-semibold">${totalCost.toFixed(2)}</span>
                  </div>
                </div>
              )}

              {/* Rollup panel — walks linkedBomId to compute true totals */}
              {items.length > 0 && (
                <BomRollupPanel bomId={selectedBomId} refreshKey={items.length} />
              )}

              {/* Baselines panel — immutable snapshots captured on release
                  or manually. Rendered for every BOM (even empty ones) so
                  the user can see the "no baselines yet" hint and trigger
                  a manual snapshot before the first release. */}
              <BomBaselinesPanel bomId={selectedBomId} canCapture={canEdit} />
            </div>
          )}
        </div>
      )}

      {/* Dialogs */}
      <CreateBomDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={handleBomCreated}
      />
      <ImportBomDialog open={showImport} onOpenChange={setShowImport} onImported={loadBoms} />

      {/* Delete confirm. BOMs are soft-deleted in the database but there is
          no trash for them yet — unlike files — so from here it is one-way,
          and the copy says so rather than promising a recovery that does not
          exist. */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{deleteTarget?.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              {(deleteTarget?.usedIn?.length ?? 0) > 0
                ? `This BOM is used as a sub-assembly in ${deleteTarget?.usedIn?.map((p) => p.name).join(", ")}. Those lines will be left pointing at nothing.`
                : "Its items and history are kept, but it cannot be restored from the app."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteTarget) handleDeleteBom(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {selectedBomId && (
        <AddItemDialog
          open={showAddItem}
          onOpenChange={setShowAddItem}
          selectedBomId={selectedBomId}
          itemCount={items.length}
          initialItemNumber={getNextItemNumber()}
          boms={boms}
          onAdded={refreshItems}
        />
      )}
      <CompareBomDialog open={showCompare} onOpenChange={setShowCompare} boms={boms} />
      {selectedBomId && selectedBomData && (
        <ShareDialog
          open={showShare}
          onOpenChange={setShowShare}
          resourceType="bom"
          resourceId={selectedBomId}
          resourceName={selectedBomData.name}
        />
      )}
    </PageContainer>
  );
}

/**
 * One row of the BOM tree.
 *
 * Rendered as a flat list rather than nested markup: a row is a button, and
 * buttons cannot legally contain buttons — the disclosure toggle and the
 * per-row menu both need to be independently clickable. `depth` carries the
 * nesting visually instead.
 */
function BomTreeRow({
  node,
  compact,
  expanded,
  onToggle,
  selectedBomId,
  unread,
  onSelect,
  canEdit,
  relinkingId,
  onRelink,
  onDelete,
}: {
  node: BomTreeNode;
  /** True when standing beside a selected BOM, i.e. in the narrow sidebar. */
  compact: boolean;
  expanded: boolean;
  onToggle: () => void;
  selectedBomId: string | null;
  unread: number;
  onSelect: (id: string) => void;
  canEdit: boolean;
  relinkingId: string | null;
  onRelink: (bom: BOM) => void;
  onDelete: (bom: BOM) => void;
}) {
  const { bom, depth, children, descendantCount } = node;
  const hasChildren = children.length > 0;
  // Indent by depth. Kept modest in the sidebar, where 14rem has to hold a
  // 48-character name as well.
  const indent = depth * (compact ? 10 : 20);

  return (
    <div className="flex items-stretch gap-1" style={{ paddingLeft: `${indent}px` }}>
      {hasChildren ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${bom.name}`}
          className="w-6 shrink-0 flex items-center justify-center rounded hover:bg-foreground/5 text-muted-foreground"
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
          )}
        </button>
      ) : (
        <span className="w-6 shrink-0" aria-hidden="true" />
      )}

      <button
        title={bom.name}
        className={`flex-1 min-w-0 text-left px-3 py-2 rounded-lg border transition-all duration-150 ${
          selectedBomId === bom.id
            ? "bg-foreground/12 text-foreground font-medium border-foreground/15"
            : "bg-card border-border/60 text-foreground hover:border-foreground/20 hover:bg-foreground/5"
        }`}
        onClick={() => onSelect(bom.id)}
      >
        {/*
          Two layouts, because the two contexts have opposite problems.

          Sidebar: 14rem for a 48-character name, so everything stacks.

          Full width: a row is ~1500px, and stacking left-aligned content
          leaves the card looking empty for most of its length. It reads as a
          list row instead — name on the left, the facts you scan down a
          column on the right, aligned across rows.
        */}
        <div className={compact ? "space-y-1" : "flex items-center justify-between gap-6 min-w-0"}>
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-1.5 min-w-0">
              <p className={`text-sm min-w-0 ${compact ? "truncate flex-1" : "truncate"}`}>
                {bom.name}
              </p>
              {unread > 0 && (
                <span
                  aria-label={`${unread} unread notification${unread === 1 ? "" : "s"}`}
                  className="bg-primary text-primary-foreground text-4xs font-bold rounded-full min-w-4 h-4 flex items-center justify-center px-1 shrink-0"
                >
                  {unread > 9 ? "9+" : unread}
                </span>
              )}
            </div>

            {/* A top-level BOM that something meant to reference but
                misspelt. Without this it sits among the products looking
                deliberate, which is how NANO-1000S Casting-Components read
                after the first import. The fix is offered here because a
                warning with no remedy just moves the work. */}
            {bom.orphanHint && (
              <div className="mt-1 rounded border border-warning/40 bg-warning/5 p-1.5 max-w-xl">
                <p className="text-3xs text-warning flex items-start gap-1">
                  <TriangleAlert className="w-3 h-3 shrink-0 mt-px" aria-hidden="true" />
                  <span className="min-w-0">
                    Not linked — a line references &ldquo;{bom.orphanHint}&rdquo;
                  </span>
                </p>
                {canEdit && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-1.5 h-6 text-3xs"
                    disabled={relinkingId === bom.id}
                    onClick={(e) => {
                      // The card navigates; repairing is a different intent.
                      e.stopPropagation();
                      onRelink(bom);
                    }}
                  >
                    {relinkingId === bom.id ? "Linking..." : "Link as sub-assembly"}
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* Fixed-width columns so the values line up down the list rather
              than shifting with each name's length. */}
          <div
            className={
              compact
                ? "flex items-center gap-1.5"
                : "flex items-center gap-6 shrink-0 text-xs text-muted-foreground"
            }
          >
            {!compact && (
              <span className="w-32 text-right tabular-nums">
                {hasChildren
                  ? `${descendantCount} sub-assembl${descendantCount === 1 ? "y" : "ies"}`
                  : "—"}
              </span>
            )}
            <span className={compact ? "text-3xs text-muted-foreground" : "w-14 text-right"}>
              Rev {bom.revision}
            </span>
            <StatusBadge
              status={bom.status}
              kind="bom"
              className={
                compact ? "text-4xs px-1.5 py-0" : "text-4xs px-1.5 py-0 w-20 justify-center"
              }
            />
          </div>
        </div>
      </button>

      {/* Delete lived only in the detail view's menu, so removing a BOM meant
          opening it first and hunting for the action. It belongs on the row. */}
      {canEdit && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="h-auto w-7 shrink-0 px-0 text-muted-foreground"
                aria-label={`Actions for ${bom.name}`}
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="w-4 h-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              className="text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(bom);
              }}
            >
              <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
