"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Plus, Download, Upload, Trash2, Package, Loader2, Search, X,
  MoreHorizontal, Pencil, Check, ChevronRight, ChevronDown, FileText, Unlink, Cpu, Link2, GitCompare,
} from "lucide-react";
import { toast } from "sonner";

// --- Types ---

interface BOM {
  id: string;
  name: string;
  revision: string;
  status: string;
  createdAt: string;
}

interface BOMItem {
  id: string;
  itemNumber: string;
  partNumber: string | null;
  name: string;
  description: string | null;
  quantity: number;
  unit: string;
  level: number;
  parentItemId: string | null;
  material: string | null;
  vendor: string | null;
  unitCost: number | null;
  sortOrder: number;
  partId: string | null;
  linkedBomId: string | null;
  file: {
    id: string;
    name: string;
    partNumber: string | null;
    revision: string;
    lifecycleState: string;
  } | null;
  part: {
    id: string;
    partNumber: string;
    name: string;
    category: string;
    thumbnailUrl: string | null;
    unitCost: number | null;
  } | null;
  linkedBom: {
    id: string;
    name: string;
    revision: string;
    status: string;
  } | null;
}

interface FileSearchResult {
  id: string;
  name: string;
  partNumber: string | null;
  category: string;
  lifecycleState: string;
}

interface PartSearchResult {
  id: string;
  partNumber: string;
  name: string;
  category: string;
  unitCost: number | null;
  thumbnailUrl: string | null;
}

// --- Constants ---

const BOM_STATUS_FLOW: Record<string, string[]> = {
  DRAFT: ["IN_REVIEW"],
  IN_REVIEW: ["APPROVED", "DRAFT"],
  APPROVED: ["RELEASED", "DRAFT"],
  RELEASED: ["OBSOLETE"],
  OBSOLETE: [],
};

const statusVariants: Record<string, "muted" | "info" | "warning" | "success" | "purple"> = {
  DRAFT: "muted",
  IN_REVIEW: "warning",
  APPROVED: "info",
  RELEASED: "success",
  OBSOLETE: "purple",
};

const statusLabels: Record<string, string> = {
  DRAFT: "Draft",
  IN_REVIEW: "In Review",
  APPROVED: "Approved",
  RELEASED: "Released",
  OBSOLETE: "Obsolete",
};

const stateVariants: Record<string, "warning" | "info" | "success" | "error"> = {
  WIP: "warning",
  "In Review": "info",
  Released: "success",
  Obsolete: "error",
};

const categoryVariants: Record<string, "info" | "success" | "muted" | "warning" | "purple"> = {
  MANUFACTURED: "info",
  PURCHASED: "success",
  STANDARD_HARDWARE: "muted",
  RAW_MATERIAL: "warning",
  SUB_ASSEMBLY: "purple",
};

// --- Helpers ---

function useDebounce<T extends (...args: Parameters<T>) => void>(fn: T, delay: number): T {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return useCallback((...args: Parameters<T>) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => fn(...args), delay);
  }, [fn, delay]) as T;
}

function buildTree(items: BOMItem[]): BOMItem[] {
  const map = new Map<string | null, BOMItem[]>();
  for (const item of items) {
    const key = item.parentItemId || null;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }

  function flatten(parentId: string | null, depth: number): BOMItem[] {
    const children = map.get(parentId) || [];
    const result: BOMItem[] = [];
    for (const child of children) {
      result.push({ ...child, level: depth });
      result.push(...flatten(child.id, depth + 1));
    }
    return result;
  }

  return flatten(null, 0);
}

// --- Component ---

export default function BOMsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [boms, setBoms] = useState<BOM[]>([]);
  const [selectedBom, setSelectedBom] = useState<string | null>(null);
  const [items, setItems] = useState<BOMItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Create BOM
  const [showCreate, setShowCreate] = useState(false);
  const [bomName, setBomName] = useState("");
  const [creating, setCreating] = useState(false);

  // Add item
  const [showAddItem, setShowAddItem] = useState(false);
  const [itemType, setItemType] = useState<"part" | "new" | "subassembly">("part");
  const [newItem, setNewItem] = useState({
    itemNumber: "", partNumber: "", name: "", quantity: "1", unit: "EA",
    material: "", vendor: "", unitCost: "", description: "",
  });
  const [itemFileId, setItemFileId] = useState<string | null>(null);
  const [itemFileName, setItemFileName] = useState("");
  const [itemFileSearch, setItemFileSearch] = useState("");
  const [itemFileResults, setItemFileResults] = useState<FileSearchResult[]>([]);
  const [itemFileSearching, setItemFileSearching] = useState(false);

  // Part picker for add item
  const [partSearch, setPartSearch] = useState("");
  const [partResults, setPartResults] = useState<PartSearchResult[]>([]);
  const [partSearching, setPartSearching] = useState(false);
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [selectedPartName, setSelectedPartName] = useState("");

  // Sub-assembly picker
  const [subBomSearch, setSubBomSearch] = useState("");
  const [selectedLinkedBomId, setSelectedLinkedBomId] = useState<string | null>(null);
  const [selectedLinkedBomName, setSelectedLinkedBomName] = useState("");

  // Compare
  const [showCompare, setShowCompare] = useState(false);
  const [compareA, setCompareA] = useState("");
  const [compareB, setCompareB] = useState("");
  const [compareResult, setCompareResult] = useState<{
    bomA: { name: string; revision: string; itemCount: number; totalCost: number };
    bomB: { name: string; revision: string; itemCount: number; totalCost: number };
    changes: { type: string; itemNumber: string; name: string; diffs: string[] }[];
    summary: { added: number; removed: number; changed: number; unchanged: number };
  } | null>(null);
  const [comparing, setComparing] = useState(false);

  // Edit item inline
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});

  // Rename BOM
  const [renamingBom, setRenamingBom] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Tree collapse
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // --- Data loading ---

  function loadBoms() {
    fetch("/api/boms").then((r) => r.json()).then((d) => {
      setBoms(Array.isArray(d) ? d : []);
      setLoading(false);
    });
  }

  useEffect(() => { loadBoms(); }, []);

  // Auto-select BOM from URL query param
  useEffect(() => {
    const bomId = searchParams.get("bomId");
    if (bomId && boms.length > 0 && !selectedBom) {
      const exists = boms.some((b) => b.id === bomId);
      if (exists) loadItems(bomId);
    }
  }, [boms, searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadItems(bomId: string) {
    setSelectedBom(bomId);
    setEditingItemId(null);
    const res = await fetch(`/api/boms/${bomId}/items`);
    const data = await res.json();
    setItems(Array.isArray(data) ? data : []);
  }

  // --- Debounced file search for item dialog ---

  const doItemFileSearch = useCallback(async (q: string) => {
    if (q.length < 2) { setItemFileResults([]); setItemFileSearching(false); return; }
    setItemFileSearching(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      setItemFileResults(Array.isArray(data) ? data.slice(0, 8) : []);
    } catch { setItemFileResults([]); }
    setItemFileSearching(false);
  }, []);

  const debouncedItemFileSearch = useDebounce(doItemFileSearch, 300);

  function handleItemFileSearchInput(q: string) {
    setItemFileSearch(q);
    if (q.length < 2) { setItemFileResults([]); return; }
    setItemFileSearching(true);
    debouncedItemFileSearch(q);
  }

  function selectFileForItem(file: FileSearchResult) {
    setItemFileId(file.id);
    setItemFileName(file.name);
    setItemFileResults([]);
    setItemFileSearch("");
    // Auto-populate fields from the file
    if (file.partNumber && !newItem.partNumber) {
      setNewItem((prev) => ({ ...prev, partNumber: file.partNumber || prev.partNumber }));
    }
    if (!newItem.name) {
      setNewItem((prev) => ({ ...prev, name: file.name }));
    }
  }

  function clearFileForItem() {
    setItemFileId(null);
    setItemFileName("");
    setItemFileSearch("");
    setItemFileResults([]);
  }

  // --- Part search for item dialog ---

  const doPartSearch = useCallback(async (q: string) => {
    if (q.length < 2) { setPartResults([]); setPartSearching(false); return; }
    setPartSearching(true);
    try {
      const res = await fetch(`/api/parts?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      setPartResults(Array.isArray(data) ? data.slice(0, 8) : []);
    } catch { setPartResults([]); }
    setPartSearching(false);
  }, []);

  const debouncedPartSearch = useDebounce(doPartSearch, 300);

  function handlePartSearchInput(q: string) {
    setPartSearch(q);
    if (q.length < 2) { setPartResults([]); return; }
    setPartSearching(true);
    debouncedPartSearch(q);
  }

  function selectPart(part: PartSearchResult) {
    setSelectedPartId(part.id);
    setSelectedPartName(`${part.partNumber} — ${part.name}`);
    setPartResults([]);
    setPartSearch("");
    setNewItem((prev) => ({
      ...prev,
      partNumber: part.partNumber,
      name: part.name,
      unitCost: part.unitCost != null ? String(part.unitCost) : prev.unitCost,
    }));
  }

  function clearPartSelection() {
    setSelectedPartId(null);
    setSelectedPartName("");
    setPartSearch("");
    setPartResults([]);
  }

  function clearAddItemState() {
    setShowAddItem(false);
    clearFileForItem();
    clearPartSelection();
    setSelectedLinkedBomId(null);
    setSelectedLinkedBomName("");
    setSubBomSearch("");
    setItemType("part");
    setNewItem({ itemNumber: "", partNumber: "", name: "", quantity: "1", unit: "EA", material: "", vendor: "", unitCost: "", description: "" });
  }

  // --- BOM CRUD ---

  async function handleCreateBom(e: React.FormEvent) {
    e.preventDefault();
    if (!bomName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/boms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: bomName.trim() }),
      });
      if (!res.ok) { const d = await res.json(); toast.error(d.error); setCreating(false); return; }
      toast.success("BOM created");
      setShowCreate(false);
      setBomName("");
      setCreating(false);
      loadBoms();
    } catch {
      toast.error("Failed to create BOM");
      setCreating(false);
    }
  }

  async function handleStatusChange(bomId: string, newStatus: string) {
    const res = await fetch(`/api/boms/${bomId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success(`Status changed to ${statusLabels[newStatus] || newStatus}`);
    loadBoms();
  }

  async function handleRenameBom(bomId: string) {
    if (!renameValue.trim()) return;
    const res = await fetch(`/api/boms/${bomId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: renameValue.trim() }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success("BOM renamed");
    setRenamingBom(null);
    setRenameValue("");
    loadBoms();
  }

  async function handleDeleteBom(bomId: string) {
    const res = await fetch(`/api/boms/${bomId}`, { method: "DELETE" });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success("BOM deleted");
    if (selectedBom === bomId) { setSelectedBom(null); setItems([]); }
    loadBoms();
  }

  // --- Item CRUD ---

  async function handleAddItem(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedBom) return;

    const res = await fetch(`/api/boms/${selectedBom}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileId: itemFileId || null,
        partId: selectedPartId || null,
        linkedBomId: selectedLinkedBomId || null,
        itemNumber: newItem.itemNumber,
        partNumber: newItem.partNumber || null,
        name: newItem.name,
        description: newItem.description || null,
        quantity: parseFloat(newItem.quantity) || 1,
        unit: newItem.unit || "EA",
        material: newItem.material || null,
        vendor: newItem.vendor || null,
        unitCost: newItem.unitCost ? parseFloat(newItem.unitCost) : null,
        sortOrder: items.length,
      }),
    });

    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success("Item added");
    clearAddItemState();
    loadItems(selectedBom);
  }

  async function handleDeleteItem(itemId: string) {
    if (!selectedBom) return;
    await fetch(`/api/boms/${selectedBom}/items`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId }),
    });
    toast.success("Item removed");
    loadItems(selectedBom);
  }

  function startEditItem(item: BOMItem) {
    setEditingItemId(item.id);
    setEditValues({
      itemNumber: item.itemNumber,
      partNumber: item.partNumber || "",
      name: item.name,
      quantity: String(item.quantity),
      unit: item.unit,
      material: item.material || "",
      vendor: item.vendor || "",
      unitCost: item.unitCost != null ? String(item.unitCost) : "",
    });
  }

  async function handleSaveItem() {
    if (!selectedBom || !editingItemId) return;
    const res = await fetch(`/api/boms/${selectedBom}/items`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        itemId: editingItemId,
        itemNumber: editValues.itemNumber,
        partNumber: editValues.partNumber || null,
        name: editValues.name,
        quantity: parseFloat(editValues.quantity) || 1,
        unit: editValues.unit,
        material: editValues.material || null,
        vendor: editValues.vendor || null,
        unitCost: editValues.unitCost ? parseFloat(editValues.unitCost) : null,
      }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    setEditingItemId(null);
    loadItems(selectedBom);
  }

  async function handleUnlinkFile(itemId: string) {
    if (!selectedBom) return;
    const res = await fetch(`/api/boms/${selectedBom}/items`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId, fileId: null }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    loadItems(selectedBom);
  }

  async function handleExport(bomId: string) {
    window.open(`/api/boms/${bomId}/export`, "_blank");
  }

  async function handleCompare() {
    if (!compareA || !compareB || compareA === compareB) return;
    setComparing(true);
    try {
      const res = await fetch(`/api/boms/compare?a=${compareA}&b=${compareB}`);
      const data = await res.json();
      if (!res.ok) { toast.error(data.error); setComparing(false); return; }
      setCompareResult(data);
    } catch { toast.error("Failed to compare"); }
    setComparing(false);
  }

  // --- CSV Import ---

  async function handleCsvImport(e: React.ChangeEvent<HTMLInputElement>) {
    if (!selectedBom || !e.target.files?.[0]) return;
    const file = e.target.files[0];
    const text = await file.text();
    const lines = text.split("\n").filter((l) => l.trim());
    if (lines.length < 2) { toast.error("CSV must have a header row and at least one data row"); return; }

    const headers = lines[0].split(",").map((h) => h.replace(/"/g, "").trim().toLowerCase());
    const itemNumIdx = headers.findIndex((h) => h.includes("item"));
    const pnIdx = headers.findIndex((h) => h.includes("part") && h.includes("num"));
    const nameIdx = headers.findIndex((h) => h === "name" || h.includes("description"));
    const qtyIdx = headers.findIndex((h) => h.includes("qty") || h.includes("quantity"));
    const unitIdx = headers.findIndex((h) => h.includes("unit"));
    const matIdx = headers.findIndex((h) => h.includes("material"));
    const vendorIdx = headers.findIndex((h) => h.includes("vendor"));
    const costIdx = headers.findIndex((h) => h.includes("cost"));

    if (nameIdx === -1) { toast.error("CSV must have a 'Name' column"); return; }

    let added = 0;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].match(/(".*?"|[^",]+|(?<=,)(?=,)|(?<=,)$)/g)?.map((c) => c.replace(/^"|"$/g, "").trim()) || [];
      const name = cols[nameIdx];
      if (!name) continue;

      const res = await fetch(`/api/boms/${selectedBom}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemNumber: cols[itemNumIdx] || String(items.length + added + 1).padStart(3, "0"),
          partNumber: pnIdx >= 0 ? cols[pnIdx] || null : null,
          name,
          quantity: qtyIdx >= 0 ? parseFloat(cols[qtyIdx]) || 1 : 1,
          unit: unitIdx >= 0 ? cols[unitIdx] || "EA" : "EA",
          material: matIdx >= 0 ? cols[matIdx] || null : null,
          vendor: vendorIdx >= 0 ? cols[vendorIdx] || null : null,
          unitCost: costIdx >= 0 ? parseFloat(cols[costIdx]) || null : null,
          sortOrder: items.length + added,
        }),
      });
      if (res.ok) added++;
    }

    toast.success(`Imported ${added} item${added !== 1 ? "s" : ""} from CSV`);
    e.target.value = "";
    loadItems(selectedBom);
  }

  // --- Derived state ---

  const totalCost = items.reduce((sum, i) => sum + (i.unitCost || 0) * i.quantity, 0);
  const selectedBomData = boms.find((b) => b.id === selectedBom);
  const treeItems = buildTree(items);
  const isEditable = selectedBomData?.status === "DRAFT" || selectedBomData?.status === "IN_REVIEW";
  const hasChildren = new Set(items.filter((i) => i.parentItemId).map((i) => i.parentItemId!));

  function toggleCollapse(itemId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
      return next;
    });
  }

  function isVisible(item: BOMItem): boolean {
    if (!item.parentItemId) return true;
    if (collapsed.has(item.parentItemId)) return false;
    const parent = treeItems.find((i) => i.id === item.parentItemId);
    return parent ? isVisible(parent) : true;
  }

  // Auto-generate next item number
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
            <Button variant="outline" size="sm" onClick={() => { setCompareA(boms[0]?.id || ""); setCompareB(boms[1]?.id || ""); setShowCompare(true); }}>
              Compare
            </Button>
          )}
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="w-4 h-4 mr-2" />
            New BOM
          </Button>
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

          {/* BOM detail */}
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
                        onKeyDown={(e) => { if (e.key === "Enter") handleRenameBom(selectedBom); if (e.key === "Escape") setRenamingBom(null); }}
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
                      <Button variant="ghost" size="icon-xs" onClick={() => { setRenamingBom(selectedBom); setRenameValue(selectedBomData.name); }} className="text-muted-foreground hover:text-foreground">
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
                  {(BOM_STATUS_FLOW[selectedBomData.status] || []).length > 0 && (
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
                            <Badge variant={statusVariants[s] || "secondary"} className="text-[10px] mr-2">{statusLabels[s]}</Badge>
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
                      <Button size="sm" onClick={() => { setNewItem((prev) => ({ ...prev, itemNumber: getNextItemNumber() })); setShowAddItem(true); }}>
                        <Plus className="w-4 h-4 mr-1" />
                        <span className="hidden sm:inline">Add Item</span>
                      </Button>
                    </>
                  )}
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
                      <DropdownMenuItem className="text-destructive" onClick={() => handleDeleteBom(selectedBom)} disabled={selectedBomData.status === "RELEASED"}>
                        <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              {/* Items table */}
              <div className="border rounded-lg bg-background overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-16">Item #</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Part #</TableHead>
                      <TableHead className="w-16">Qty</TableHead>
                      <TableHead className="w-14">Unit</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Material</TableHead>
                      <TableHead>Vendor</TableHead>
                      <TableHead className="w-20">Unit Cost</TableHead>
                      <TableHead className="w-20">Ext.</TableHead>
                      {isEditable && <TableHead className="w-16"></TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={isEditable ? 11 : 10} className="text-center py-12 text-muted-foreground">
                          <Package className="w-8 h-8 mx-auto mb-2 opacity-30" />
                          No items yet. {isEditable ? "Click \"Add Item\" to add parts." : ""}
                        </TableCell>
                      </TableRow>
                    ) : (
                      treeItems.filter(isVisible).map((item) => {
                        const isEditing = editingItemId === item.id;
                        const hasKids = hasChildren.has(item.id);
                        const isCollapsed = collapsed.has(item.id);

                        return (
                          <TableRow key={item.id} className={item.level > 0 ? "bg-muted/20" : ""}>
                            {/* Item # with tree indent */}
                            <TableCell className="font-mono text-xs">
                              <div className="flex items-center" style={{ paddingLeft: `${item.level * 16}px` }}>
                                {hasKids ? (
                                  <button onClick={() => toggleCollapse(item.id)} className="mr-1 p-0.5 hover:bg-muted rounded">
                                    {isCollapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                                  </button>
                                ) : item.level > 0 ? (
                                  <span className="w-4 mr-1 inline-block text-center text-muted-foreground">·</span>
                                ) : null}
                                {isEditing ? (
                                  <Input value={editValues.itemNumber} onChange={(e) => setEditValues({ ...editValues, itemNumber: e.target.value })} className="h-6 w-14 text-xs px-1" />
                                ) : item.itemNumber}
                              </div>
                            </TableCell>

                            {/* Name */}
                            <TableCell className="font-medium text-sm">
                              {isEditing ? (
                                <Input value={editValues.name} onChange={(e) => setEditValues({ ...editValues, name: e.target.value })} className="h-6 text-xs px-1" />
                              ) : item.name}
                            </TableCell>

                            {/* Part # */}
                            <TableCell className="text-sm">
                              {isEditing ? (
                                <Input value={editValues.partNumber} onChange={(e) => setEditValues({ ...editValues, partNumber: e.target.value })} className="h-6 text-xs px-1" />
                              ) : (
                                item.partNumber || item.file?.partNumber || "—"
                              )}
                            </TableCell>

                            {/* Qty */}
                            <TableCell className="text-sm">
                              {isEditing ? (
                                <Input type="number" value={editValues.quantity} onChange={(e) => setEditValues({ ...editValues, quantity: e.target.value })} className="h-6 w-16 text-xs px-1" min="0" step="any" />
                              ) : item.quantity}
                            </TableCell>

                            {/* Unit */}
                            <TableCell className="text-xs">
                              {isEditing ? (
                                <Input value={editValues.unit} onChange={(e) => setEditValues({ ...editValues, unit: e.target.value })} className="h-6 w-12 text-xs px-1" />
                              ) : item.unit}
                            </TableCell>

                            {/* Source: part / sub-assembly / file */}
                            <TableCell className="text-sm">
                              {item.part ? (
                                <div className="flex items-center gap-1.5">
                                  <Cpu className="w-3 h-3 text-muted-foreground shrink-0" />
                                  <button className="text-xs hover:underline truncate max-w-28" onClick={() => router.push("/parts")} title={item.part.name}>
                                    {item.part.partNumber}
                                  </button>
                                  <Badge variant={categoryVariants[(item.part as BOMItem["part"] & { category: string }).category] || "secondary"} className="text-[9px] px-1 py-0">
                                    {(item.part as BOMItem["part"] & { category: string }).category.replace("_", " ").toLowerCase()}
                                  </Badge>
                                </div>
                              ) : (item.linkedBom as BOMItem["linkedBom"]) ? (
                                <div className="flex items-center gap-1.5">
                                  <Package className="w-3 h-3 text-muted-foreground shrink-0" />
                                  <span className="text-xs truncate max-w-28">{(item.linkedBom as NonNullable<BOMItem["linkedBom"]>).name}</span>
                                  <Badge variant={statusVariants[(item.linkedBom as NonNullable<BOMItem["linkedBom"]>).status] || "secondary"} className="text-[9px] px-1 py-0">
                                    {statusLabels[(item.linkedBom as NonNullable<BOMItem["linkedBom"]>).status]}
                                  </Badge>
                                </div>
                              ) : item.file ? (
                                <div className="flex items-center gap-1.5">
                                  <FileText className="w-3 h-3 text-muted-foreground shrink-0" />
                                  <button className="text-xs hover:underline truncate max-w-28" onClick={() => router.push(`/vault?fileId=${item.file!.id}`)} title={item.file.name}>
                                    {item.file.name}
                                  </button>
                                  <Badge variant={stateVariants[item.file.lifecycleState] || "secondary"} className="text-[9px] px-1 py-0">
                                    {item.file.lifecycleState}
                                  </Badge>
                                </div>
                              ) : (
                                <span className="text-muted-foreground text-xs">—</span>
                              )}
                            </TableCell>

                            {/* Material */}
                            <TableCell className="text-sm">
                              {isEditing ? (
                                <Input value={editValues.material} onChange={(e) => setEditValues({ ...editValues, material: e.target.value })} className="h-6 text-xs px-1" />
                              ) : item.material || "—"}
                            </TableCell>

                            {/* Vendor */}
                            <TableCell className="text-sm">
                              {isEditing ? (
                                <Input value={editValues.vendor} onChange={(e) => setEditValues({ ...editValues, vendor: e.target.value })} className="h-6 text-xs px-1" />
                              ) : item.vendor || "—"}
                            </TableCell>

                            {/* Unit Cost */}
                            <TableCell className="font-mono text-sm">
                              {isEditing ? (
                                <Input type="number" value={editValues.unitCost} onChange={(e) => setEditValues({ ...editValues, unitCost: e.target.value })} className="h-6 w-20 text-xs px-1" min="0" step="0.01" />
                              ) : item.unitCost != null ? `$${item.unitCost.toFixed(2)}` : "—"}
                            </TableCell>

                            {/* Ext. Cost */}
                            <TableCell className="font-mono text-sm">
                              {item.unitCost != null ? `$${(item.unitCost * item.quantity).toFixed(2)}` : "—"}
                            </TableCell>

                            {/* Actions */}
                            {isEditable && (
                              <TableCell>
                                <div className="flex items-center gap-0.5">
                                  {isEditing ? (
                                    <>
                                      <Button variant="ghost" size="icon-xs" onClick={handleSaveItem}><Check className="w-3.5 h-3.5 text-green-600" /></Button>
                                      <Button variant="ghost" size="icon-xs" onClick={() => setEditingItemId(null)}><X className="w-3.5 h-3.5" /></Button>
                                    </>
                                  ) : (
                                    <>
                                      <Button variant="ghost" size="icon-xs" onClick={() => startEditItem(item)}><Pencil className="w-3 h-3" /></Button>
                                      <Button variant="ghost" size="icon-xs" className="text-destructive" onClick={() => handleDeleteItem(item.id)}><Trash2 className="w-3 h-3" /></Button>
                                    </>
                                  )}
                                </div>
                              </TableCell>
                            )}
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>

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

      {/* Create BOM dialog — simple, no file link */}
      <Dialog open={showCreate} onOpenChange={(open) => { if (!open) { setShowCreate(false); setBomName(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Bill of Materials</DialogTitle>
            <DialogDescription>
              Create a BOM to list the parts and materials needed to build something. You&apos;ll add items and link them to vault files after creating it.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateBom}>
            <div className="py-4">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input
                  value={bomName}
                  onChange={(e) => setBomName(e.target.value)}
                  placeholder="e.g., Motor Assembly BOM"
                  required
                  autoFocus
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => { setShowCreate(false); setBomName(""); }}>Cancel</Button>
              <Button type="submit" disabled={creating || !bomName.trim()}>
                {creating ? "Creating..." : "Create BOM"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Add item dialog */}
      <Dialog open={showAddItem} onOpenChange={(open) => { if (!open) clearAddItemState(); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Item</DialogTitle>
            <DialogDescription>
              Add from your parts library, enter a new part manually, or link a sub-assembly BOM.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAddItem}>
            <div className="space-y-4 py-4">
              {/* Type selector */}
              <div className="flex gap-1 p-1 bg-muted/50 rounded-lg">
                {([
                  { key: "part" as const, label: "From Library", icon: Cpu },
                  { key: "new" as const, label: "New Part", icon: Plus },
                  { key: "subassembly" as const, label: "Sub-Assembly", icon: Link2 },
                ]).map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    type="button"
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      itemType === key ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                    }`}
                    onClick={() => { setItemType(key); clearPartSelection(); clearFileForItem(); setSelectedLinkedBomId(null); setSelectedLinkedBomName(""); }}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </button>
                ))}
              </div>

              {/* Item # — always visible */}
              <div className="space-y-1">
                <Label className="text-xs">Item #</Label>
                <Input value={newItem.itemNumber} onChange={(e) => setNewItem({ ...newItem, itemNumber: e.target.value })} placeholder="001" className="h-8 text-sm" required />
              </div>

              {/* FROM PARTS LIBRARY */}
              {itemType === "part" && (
                <div className="space-y-3">
                  {selectedPartId ? (
                    <div className="flex items-center gap-2 border rounded-lg px-3 py-2 bg-muted/30">
                      <Cpu className="w-4 h-4 text-muted-foreground shrink-0" />
                      <span className="text-sm flex-1 truncate">{selectedPartName}</span>
                      <Button type="button" variant="ghost" size="icon-xs" onClick={clearPartSelection}>
                        <X className="w-3 h-3" />
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                        <Input
                          value={partSearch}
                          onChange={(e) => handlePartSearchInput(e.target.value)}
                          placeholder="Search parts by number or name..."
                          className="pl-8 h-8 text-sm"
                          autoFocus
                        />
                      </div>
                      {partSearching && <div className="flex justify-center py-2"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>}
                      {partResults.length > 0 && (
                        <div className="border rounded-lg max-h-40 overflow-y-auto">
                          {partResults.map((p) => (
                            <button key={p.id} type="button" className="w-full text-left px-3 py-2 text-sm hover:bg-muted/50 transition-colors flex items-center gap-2" onClick={() => selectPart(p)}>
                              {p.thumbnailUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={p.thumbnailUrl} alt="" className="w-6 h-6 rounded object-cover shrink-0" />
                              ) : (
                                <Cpu className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                              )}
                              <span className="font-mono text-xs shrink-0">{p.partNumber}</span>
                              <span className="truncate">{p.name}</span>
                              {p.unitCost != null && <span className="text-xs text-muted-foreground ml-auto shrink-0">${p.unitCost.toFixed(2)}</span>}
                            </button>
                          ))}
                        </div>
                      )}
                      {partSearch.length >= 2 && !partSearching && partResults.length === 0 && (
                        <p className="text-xs text-muted-foreground text-center py-1">No parts found</p>
                      )}
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs">Quantity</Label>
                      <Input type="number" value={newItem.quantity} onChange={(e) => setNewItem({ ...newItem, quantity: e.target.value })} className="h-8 text-sm" min="0.001" step="any" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Unit</Label>
                      <Input value={newItem.unit} onChange={(e) => setNewItem({ ...newItem, unit: e.target.value })} placeholder="EA" className="h-8 text-sm" />
                    </div>
                  </div>
                </div>
              )}

              {/* NEW PART (manual entry) */}
              {itemType === "new" && (
                <div className="space-y-3">
                  {/* Optional vault file link */}
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Link vault file (optional)</Label>
                    {itemFileId ? (
                      <div className="flex items-center gap-2 border rounded-lg px-3 py-1.5 bg-muted/30">
                        <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        <span className="text-sm flex-1 truncate">{itemFileName}</span>
                        <Button type="button" variant="ghost" size="icon-xs" onClick={clearFileForItem}><X className="w-3 h-3" /></Button>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <div className="relative">
                          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                          <Input value={itemFileSearch} onChange={(e) => handleItemFileSearchInput(e.target.value)} placeholder="Search vault files..." className="pl-8 h-8 text-sm" />
                        </div>
                        {itemFileSearching && <div className="flex justify-center py-1"><Loader2 className="w-3 h-3 animate-spin text-muted-foreground" /></div>}
                        {itemFileResults.length > 0 && (
                          <div className="border rounded-lg max-h-28 overflow-y-auto">
                            {itemFileResults.map((f) => (
                              <button key={f.id} type="button" className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted/50 flex items-center gap-2" onClick={() => selectFileForItem(f)}>
                                <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                <span className="truncate">{f.name}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs">Part Number</Label>
                      <Input value={newItem.partNumber} onChange={(e) => setNewItem({ ...newItem, partNumber: e.target.value })} placeholder="PACE-1001" className="h-8 text-sm" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Name</Label>
                      <Input value={newItem.name} onChange={(e) => setNewItem({ ...newItem, name: e.target.value })} placeholder="Motor Housing" className="h-8 text-sm" required />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Quantity</Label>
                      <Input type="number" value={newItem.quantity} onChange={(e) => setNewItem({ ...newItem, quantity: e.target.value })} className="h-8 text-sm" min="0.001" step="any" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Unit</Label>
                      <Input value={newItem.unit} onChange={(e) => setNewItem({ ...newItem, unit: e.target.value })} placeholder="EA" className="h-8 text-sm" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Material</Label>
                      <Input value={newItem.material} onChange={(e) => setNewItem({ ...newItem, material: e.target.value })} placeholder="304 SS" className="h-8 text-sm" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Vendor</Label>
                      <Input value={newItem.vendor} onChange={(e) => setNewItem({ ...newItem, vendor: e.target.value })} placeholder="McMaster" className="h-8 text-sm" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Unit Cost ($)</Label>
                      <Input type="number" value={newItem.unitCost} onChange={(e) => setNewItem({ ...newItem, unitCost: e.target.value })} placeholder="0.00" className="h-8 text-sm" min="0" step="0.01" />
                    </div>
                  </div>
                </div>
              )}

              {/* SUB-ASSEMBLY */}
              {itemType === "subassembly" && (
                <div className="space-y-3">
                  {selectedLinkedBomId ? (
                    <div className="flex items-center gap-2 border rounded-lg px-3 py-2 bg-muted/30">
                      <Package className="w-4 h-4 text-muted-foreground shrink-0" />
                      <span className="text-sm flex-1 truncate">{selectedLinkedBomName}</span>
                      <Button type="button" variant="ghost" size="icon-xs" onClick={() => { setSelectedLinkedBomId(null); setSelectedLinkedBomName(""); }}>
                        <X className="w-3 h-3" />
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <Label className="text-xs">Select a BOM to nest as a sub-assembly</Label>
                      <div className="border rounded-lg max-h-40 overflow-y-auto">
                        {boms.filter((b) => b.id !== selectedBom).length === 0 ? (
                          <p className="text-xs text-muted-foreground text-center py-3">No other BOMs available</p>
                        ) : (
                          boms.filter((b) => b.id !== selectedBom).map((b) => (
                            <button
                              key={b.id}
                              type="button"
                              className="w-full text-left px-3 py-2 text-sm hover:bg-muted/50 transition-colors flex items-center gap-2"
                              onClick={() => {
                                setSelectedLinkedBomId(b.id);
                                setSelectedLinkedBomName(b.name);
                                setNewItem((prev) => ({ ...prev, name: prev.name || b.name }));
                              }}
                            >
                              <Package className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                              <span className="truncate">{b.name}</span>
                              <Badge variant={statusVariants[b.status] || "secondary"} className="text-[9px] px-1 py-0 ml-auto shrink-0">
                                {statusLabels[b.status]}
                              </Badge>
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2 space-y-1">
                      <Label className="text-xs">Name</Label>
                      <Input value={newItem.name} onChange={(e) => setNewItem({ ...newItem, name: e.target.value })} placeholder="Rotor Sub-Assembly" className="h-8 text-sm" required />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Quantity</Label>
                      <Input type="number" value={newItem.quantity} onChange={(e) => setNewItem({ ...newItem, quantity: e.target.value })} className="h-8 text-sm" min="0.001" step="any" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Unit</Label>
                      <Input value={newItem.unit} onChange={(e) => setNewItem({ ...newItem, unit: e.target.value })} placeholder="EA" className="h-8 text-sm" />
                    </div>
                  </div>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={clearAddItemState}>Cancel</Button>
              <Button type="submit" disabled={
                !newItem.name.trim() || (itemType === "part" && !selectedPartId) || (itemType === "subassembly" && !selectedLinkedBomId)
              }>Add Item</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Compare dialog */}
      <Dialog open={showCompare} onOpenChange={(open) => { if (!open) { setShowCompare(false); setCompareResult(null); } }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Compare BOMs</DialogTitle>
            <DialogDescription>Select two BOMs to compare their items side by side.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">BOM A (baseline)</Label>
                <select className="w-full h-8 rounded-lg border border-input bg-transparent px-2 text-sm" value={compareA} onChange={(e) => setCompareA(e.target.value)}>
                  {boms.map((b) => <option key={b.id} value={b.id}>{b.name} (Rev {b.revision})</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">BOM B (compare to)</Label>
                <select className="w-full h-8 rounded-lg border border-input bg-transparent px-2 text-sm" value={compareB} onChange={(e) => setCompareB(e.target.value)}>
                  {boms.map((b) => <option key={b.id} value={b.id}>{b.name} (Rev {b.revision})</option>)}
                </select>
              </div>
            </div>
            <Button onClick={handleCompare} disabled={comparing || !compareA || !compareB || compareA === compareB} size="sm">
              {comparing ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Comparing...</> : "Compare"}
            </Button>

            {compareResult && (
              <div className="space-y-3 mt-2">
                {/* Summary */}
                <div className="flex gap-3 text-sm">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-green-500" />
                    <span>{compareResult.summary.added} added</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-red-500" />
                    <span>{compareResult.summary.removed} removed</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-yellow-500" />
                    <span>{compareResult.summary.changed} changed</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-gray-300" />
                    <span>{compareResult.summary.unchanged} unchanged</span>
                  </div>
                </div>

                {/* Cost comparison */}
                <div className="text-sm text-muted-foreground">
                  Cost: ${compareResult.bomA.totalCost.toFixed(2)} → ${compareResult.bomB.totalCost.toFixed(2)}
                  {compareResult.bomB.totalCost !== compareResult.bomA.totalCost && (
                    <span className={compareResult.bomB.totalCost > compareResult.bomA.totalCost ? "text-red-500 ml-1" : "text-green-500 ml-1"}>
                      ({compareResult.bomB.totalCost > compareResult.bomA.totalCost ? "+" : ""}{(compareResult.bomB.totalCost - compareResult.bomA.totalCost).toFixed(2)})
                    </span>
                  )}
                </div>

                {/* Changes table */}
                <div className="border rounded-lg max-h-64 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">Status</TableHead>
                        <TableHead>Item #</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Changes</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {compareResult.changes.filter((c) => c.type !== "unchanged").map((change, i) => (
                        <TableRow key={i} className={
                          change.type === "added" ? "bg-green-500/5" :
                          change.type === "removed" ? "bg-red-500/5" :
                          "bg-yellow-500/5"
                        }>
                          <TableCell>
                            <Badge variant={change.type === "added" ? "success" : change.type === "removed" ? "error" : "warning"} className="text-[9px]">
                              {change.type}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs">{change.itemNumber}</TableCell>
                          <TableCell className="text-sm">{change.name}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {change.diffs.join(", ")}
                          </TableCell>
                        </TableRow>
                      ))}
                      {compareResult.changes.filter((c) => c.type !== "unchanged").length === 0 && (
                        <TableRow>
                          <TableCell colSpan={4} className="text-center py-4 text-muted-foreground text-sm">
                            No differences found. The BOMs are identical.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
