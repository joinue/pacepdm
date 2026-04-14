"use client";

import { useState, useCallback } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Plus, Search, Loader2, X, FileText, Cpu, Link2, Package,
} from "lucide-react";
import { fetchJson, errorMessage } from "@/lib/api-client";
import { useDebounce } from "../utils";
import { statusVariants, statusLabels } from "../constants";
import {
  type BOM,
  type FileSearchResult,
  type PartSearchResult,
  type NewItemForm,
  EMPTY_NEW_ITEM,
} from "../types";

interface AddItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedBomId: string;
  /** Used to compute sortOrder and the default item number for new items. */
  itemCount: number;
  initialItemNumber: string;
  /** All BOMs in the workspace, used by the sub-assembly picker. */
  boms: BOM[];
  /** Called after a successful add so the parent can reload its item list. */
  onAdded: () => void;
}

type ItemType = "part" | "new" | "subassembly";

/**
 * Add Item dialog. Three modes:
 *
 *   1. From parts library — pick an existing part, item is linked by partId
 *   2. New part         — manually enter all fields, optionally link a vault file
 *   3. Sub-assembly     — pick another BOM to nest as a child
 *
 * State for each mode is owned here so the parent doesn't accumulate it.
 */
export function AddItemDialog({
  open,
  onOpenChange,
  selectedBomId,
  itemCount,
  initialItemNumber,
  boms,
  onAdded,
}: AddItemDialogProps) {
  const [itemType, setItemType] = useState<ItemType>("part");
  const [newItem, setNewItem] = useState<NewItemForm>({ ...EMPTY_NEW_ITEM, itemNumber: initialItemNumber });

  // Linked vault file (new part mode)
  const [itemFileId, setItemFileId] = useState<string | null>(null);
  const [itemFileName, setItemFileName] = useState("");
  const [itemFileSearch, setItemFileSearch] = useState("");
  const [itemFileResults, setItemFileResults] = useState<FileSearchResult[]>([]);
  const [itemFileSearching, setItemFileSearching] = useState(false);

  // Part picker (parts library mode)
  const [partSearch, setPartSearch] = useState("");
  const [partResults, setPartResults] = useState<PartSearchResult[]>([]);
  const [partSearching, setPartSearching] = useState(false);
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [selectedPartName, setSelectedPartName] = useState("");

  // Sub-assembly picker
  const [selectedLinkedBomId, setSelectedLinkedBomId] = useState<string | null>(null);
  const [selectedLinkedBomName, setSelectedLinkedBomName] = useState("");

  // Reset dialog when initialItemNumber changes (e.g., after adding multiple items in a row)
  function resetForm() {
    setNewItem({ ...EMPTY_NEW_ITEM, itemNumber: initialItemNumber });
    clearFileForItem();
    clearPartSelection();
    setSelectedLinkedBomId(null);
    setSelectedLinkedBomName("");
    setItemType("part");
  }

  function close() {
    onOpenChange(false);
    resetForm();
  }

  // ─── File search ──────────────────────────────────────────────────────
  const doFileSearch = useCallback(async (q: string) => {
    if (q.length < 2) {
      setItemFileResults([]);
      setItemFileSearching(false);
      return;
    }
    setItemFileSearching(true);
    try {
      const data = await fetchJson<FileSearchResult[]>(`/api/search?q=${encodeURIComponent(q)}`);
      setItemFileResults(Array.isArray(data) ? data.slice(0, 8) : []);
    } catch {
      setItemFileResults([]);
    } finally {
      setItemFileSearching(false);
    }
  }, []);
  const debouncedFileSearch = useDebounce(doFileSearch, 300);

  function handleFileSearchInput(q: string) {
    setItemFileSearch(q);
    if (q.length < 2) {
      setItemFileResults([]);
      return;
    }
    setItemFileSearching(true);
    debouncedFileSearch(q);
  }

  function selectFileForItem(file: FileSearchResult) {
    setItemFileId(file.id);
    setItemFileName(file.name);
    setItemFileResults([]);
    setItemFileSearch("");
    // Auto-populate fields if empty
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

  // ─── Part search ──────────────────────────────────────────────────────
  const doPartSearch = useCallback(async (q: string) => {
    if (q.length < 2) {
      setPartResults([]);
      setPartSearching(false);
      return;
    }
    setPartSearching(true);
    try {
      const data = await fetchJson<PartSearchResult[]>(`/api/parts?q=${encodeURIComponent(q)}`);
      setPartResults(Array.isArray(data) ? data.slice(0, 8) : []);
    } catch {
      setPartResults([]);
    } finally {
      setPartSearching(false);
    }
  }, []);
  const debouncedPartSearch = useDebounce(doPartSearch, 300);

  function handlePartSearchInput(q: string) {
    setPartSearch(q);
    if (q.length < 2) {
      setPartResults([]);
      return;
    }
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

  // ─── Submit ───────────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await fetchJson(`/api/boms/${selectedBomId}/items`, {
        method: "POST",
        body: {
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
          sortOrder: itemCount,
        },
      });
      toast.success("Item added");
      close();
      onAdded();
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to add item");
    }
  }

  const submitDisabled =
    !newItem.name.trim()
    || (itemType === "part" && !selectedPartId)
    || (itemType === "subassembly" && !selectedLinkedBomId);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-xl flex flex-col max-h-[85vh] h-155">
        <DialogHeader>
          <DialogTitle>Add Item</DialogTitle>
          <DialogDescription>
            Add from your parts library, enter a new part manually, or link a sub-assembly BOM.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <div className="space-y-4 py-4 flex-1 overflow-y-auto pr-1">
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
                  onClick={() => {
                    setItemType(key);
                    clearPartSelection();
                    clearFileForItem();
                    setSelectedLinkedBomId(null);
                    setSelectedLinkedBomName("");
                  }}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </button>
              ))}
            </div>

            {/* Item # — always visible */}
            <div className="space-y-1">
              <Label className="text-xs">Item #</Label>
              <Input
                value={newItem.itemNumber}
                onChange={(e) => setNewItem({ ...newItem, itemNumber: e.target.value })}
                placeholder="001"
                className="h-8 text-sm"
                required
              />
            </div>

            {/* From parts library */}
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
                          <button
                            key={p.id}
                            type="button"
                            className="w-full text-left px-3 py-2 text-sm hover:bg-muted/50 transition-colors flex items-center gap-2"
                            onClick={() => selectPart(p)}
                          >
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

            {/* New part (manual entry) */}
            {itemType === "new" && (
              <div className="space-y-3">
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
                        <Input value={itemFileSearch} onChange={(e) => handleFileSearchInput(e.target.value)} placeholder="Search vault files..." className="pl-8 h-8 text-sm" />
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

            {/* Sub-assembly */}
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
                      {boms.filter((b) => b.id !== selectedBomId).length === 0 ? (
                        <p className="text-xs text-muted-foreground text-center py-3">No other BOMs available</p>
                      ) : (
                        boms.filter((b) => b.id !== selectedBomId).map((b) => (
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
            <Button type="button" variant="outline" onClick={close}>Cancel</Button>
            <Button type="submit" disabled={submitDisabled}>Add Item</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
