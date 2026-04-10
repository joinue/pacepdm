"use client";

import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Plus, Download, Upload, Trash2, Package, Loader2,
  MoreHorizontal, Pencil, Check, ChevronDown, X,
} from "lucide-react";
import { toast } from "sonner";
import { BOM_STATUS_FLOW } from "@/lib/status-flows";
import { fetchJson, errorMessage } from "@/lib/api-client";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/lib/permissions";

import type { BOM, BOMItem } from "./types";
import { statusVariants, statusLabels } from "./constants";
import { CreateBomDialog } from "./components/create-bom-dialog";
import { CompareBomDialog } from "./components/compare-bom-dialog";
import { AddItemDialog } from "./components/add-item-dialog";
import { BomItemsTable } from "./components/bom-items-table";

/**
 * BOMs page — composition root.
 *
 * Owns:
 *   - The BOM list and the currently selected BOM
 *   - The selected BOM's items (loaded on demand)
 *   - Dialog visibility flags
 *   - BOM-level mutations (create, rename, delete, status change, CSV import)
 *
 * Item-level concerns (add, edit, delete, tree rendering, compare) live in
 * the components under `./components/`. Types and constants live in
 * `./types.ts` and `./constants.ts`.
 *
 * The previous version was a single 1300-line file. This page is now a
 * thin coordinator and should stay that way — when adding a feature, prefer
 * extracting a new component over inlining more JSX here.
 */
export default function BOMsPage() {
  const searchParams = useSearchParams();
  const { can } = usePermissions();
  const canEdit = can(PERMISSIONS.FILE_EDIT);

  const [boms, setBoms] = useState<BOM[]>([]);
  const [selectedBom, setSelectedBom] = useState<string | null>(null);
  const [items, setItems] = useState<BOMItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Dialog visibility
  const [showCreate, setShowCreate] = useState(false);
  const [showAddItem, setShowAddItem] = useState(false);
  const [showCompare, setShowCompare] = useState(false);

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

  const loadItems = useCallback(async (bomId: string) => {
    setSelectedBom(bomId);
    try {
      const data = await fetchJson<BOMItem[]>(`/api/boms/${bomId}/items`);
      setItems(Array.isArray(data) ? data : []);
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to load BOM items");
    }
  }, []);

  // Convenience: refresh items for the currently selected BOM
  const refreshItems = useCallback(() => {
    if (selectedBom) loadItems(selectedBom);
  }, [selectedBom, loadItems]);

  useEffect(() => {
    void (async () => { await loadBoms(); })();
  }, [loadBoms]);

  // Auto-select BOM from URL query param. The deep-link case where the user
  // bookmarks /boms?bomId=xyz.
  useEffect(() => {
    const bomId = searchParams.get("bomId");
    if (!bomId || boms.length === 0 || selectedBom) return;
    if (!boms.some((b) => b.id === bomId)) return;
    void (async () => { await loadItems(bomId); })();
  }, [boms, searchParams, selectedBom, loadItems]);

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
      if (selectedBom === bomId) {
        setSelectedBom(null);
        setItems([]);
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
    if (!selectedBom || !e.target.files?.[0]) return;
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
      const cols = lines[i].match(/(".*?"|[^",]+|(?<=,)(?=,)|(?<=,)$)/g)?.map((c) => c.replace(/^"|"$/g, "").trim()) || [];
      const name = cols[nameIdx];
      if (!name) {
        skipped++;
        continue;
      }
      rowsToImport.push({
        itemNumber: cols[itemNumIdx] || String(items.length + rowsToImport.length + 1).padStart(3, "0"),
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
      const result = await fetchJson<{ inserted: number }>(
        `/api/boms/${selectedBom}/items`,
        { method: "POST", body: { items: rowsToImport } }
      );
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
  const selectedBomData = boms.find((b) => b.id === selectedBom);
  const isEditable = canEdit && (selectedBomData?.status === "DRAFT" || selectedBomData?.status === "IN_REVIEW");

  // Auto-generate next item number for the Add Item dialog
  function getNextItemNumber(): string {
    if (items.length === 0) return "001";
    const nums = items.map((i) => parseInt(i.itemNumber, 10)).filter((n) => !isNaN(n));
    const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
    return String(next).padStart(3, "0");
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Bill of Materials</h2>
        <div className="flex gap-2">
          {boms.length >= 2 && (
            <Button variant="outline" size="sm" onClick={() => setShowCompare(true)}>
              Compare
            </Button>
          )}
          {canEdit && (
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="w-4 h-4 mr-2" />
              New BOM
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : boms.length === 0 && !selectedBom ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Package className="w-10 h-10 mx-auto mb-3 text-muted-foreground/30" />
            <p className="text-muted-foreground">No BOMs yet. Click &ldquo;New BOM&rdquo; to create one.</p>
            <p className="text-xs text-muted-foreground mt-1">
              A BOM is a list of parts and materials needed to build something.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex gap-4 flex-col lg:flex-row">
          {/* BOM list sidebar */}
          <div className="lg:w-56 shrink-0 space-y-1">
            {boms.map((bom) => (
              <button
                key={bom.id}
                className={`w-full text-left px-3 py-2 rounded-lg transition-all duration-150 ${
                  selectedBom === bom.id
                    ? "bg-foreground/12 text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-foreground/6"
                }`}
                onClick={() => loadItems(bom.id)}
              >
                <p className="text-sm truncate">{bom.name}</p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <Badge variant={statusVariants[bom.status] || "secondary"} className="text-[9px] px-1.5 py-0">
                    {statusLabels[bom.status] || bom.status}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground">Rev {bom.revision}</span>
                </div>
              </button>
            ))}
          </div>

          {/* Selected BOM detail */}
          {selectedBom && selectedBomData && (
            <div className="flex-1 space-y-4 min-w-0">
              {/* Detail header */}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  {renamingBom === selectedBom ? (
                    <div className="flex items-center gap-2">
                      <Input
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        className="h-8 text-lg font-semibold px-2 w-64"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleRenameBom(selectedBom);
                          if (e.key === "Escape") setRenamingBom(null);
                        }}
                      />
                      <Button variant="ghost" size="icon-sm" onClick={() => handleRenameBom(selectedBom)}>
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
                        onClick={() => { setRenamingBom(selectedBom); setRenameValue(selectedBomData.name); }}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <Pencil className="w-3 h-3" />
                      </Button>
                    </div>
                  )}
                  <div className="flex items-center gap-3 mt-1">
                    <Badge variant={statusVariants[selectedBomData.status] || "secondary"}>
                      {statusLabels[selectedBomData.status] || selectedBomData.status}
                    </Badge>
                    <span className="text-sm text-muted-foreground">
                      Rev {selectedBomData.revision} &middot; {items.length} item{items.length !== 1 ? "s" : ""} &middot; ${totalCost.toFixed(2)}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {/* Status transitions */}
                  {(BOM_STATUS_FLOW[selectedBomData.status] || []).length > 0 && canEdit && (
                    <DropdownMenu>
                      <DropdownMenuTrigger render={
                        <Button variant="outline" size="sm">
                          Status
                          <ChevronDown className="w-3 h-3 ml-1" />
                        </Button>
                      } />
                      <DropdownMenuContent align="end">
                        {(BOM_STATUS_FLOW[selectedBomData.status] || []).map((s) => (
                          <DropdownMenuItem key={s} onClick={() => handleStatusChange(selectedBom, s)}>
                            <Badge variant={statusVariants[s] || "secondary"} className="text-[10px] mr-2">
                              {statusLabels[s]}
                            </Badge>
                            {statusLabels[s]}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  <Button variant="outline" size="sm" onClick={() => handleExport(selectedBom)}>
                    <Download className="w-4 h-4 mr-1" />
                    <span className="hidden sm:inline">Export</span>
                  </Button>
                  {isEditable && (
                    <>
                      <label className="inline-flex items-center justify-center rounded-full border border-border bg-background hover:bg-muted text-sm font-medium h-8 gap-1.5 px-2.5 cursor-pointer transition-all">
                        <Upload className="w-4 h-4" />
                        <span className="hidden sm:inline">Import CSV</span>
                        <input type="file" accept=".csv" className="hidden" onChange={handleCsvImport} />
                      </label>
                      <Button size="sm" onClick={() => setShowAddItem(true)}>
                        <Plus className="w-4 h-4 mr-1" />
                        <span className="hidden sm:inline">Add Item</span>
                      </Button>
                    </>
                  )}
                  {canEdit && (
                    <DropdownMenu>
                      <DropdownMenuTrigger render={
                        <Button variant="ghost" size="icon-sm">
                          <MoreHorizontal className="w-4 h-4" />
                        </Button>
                      } />
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => { setRenamingBom(selectedBom); setRenameValue(selectedBomData.name); }}>
                          <Pencil className="w-3.5 h-3.5 mr-2" /> Rename
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={() => handleDeleteBom(selectedBom)}
                          disabled={selectedBomData.status === "RELEASED"}
                        >
                          <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </div>

              {/* Items table */}
              <BomItemsTable
                items={items}
                bomId={selectedBom}
                isEditable={!!isEditable}
                onItemsChanged={refreshItems}
              />

              {/* Cost summary */}
              {items.length > 0 && (
                <div className="flex justify-end text-sm">
                  <div className="bg-muted/50 rounded-lg px-4 py-2 text-right">
                    <span className="text-muted-foreground mr-3">Total ({items.length} items)</span>
                    <span className="font-mono font-semibold">${totalCost.toFixed(2)}</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Dialogs */}
      <CreateBomDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={loadBoms}
      />
      {selectedBom && (
        <AddItemDialog
          open={showAddItem}
          onOpenChange={setShowAddItem}
          selectedBomId={selectedBom}
          itemCount={items.length}
          initialItemNumber={getNextItemNumber()}
          boms={boms}
          onAdded={refreshItems}
        />
      )}
      <CompareBomDialog
        open={showCompare}
        onOpenChange={setShowCompare}
        boms={boms}
      />
    </div>
  );
}
