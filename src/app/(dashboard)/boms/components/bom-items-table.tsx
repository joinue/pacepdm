"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Pencil, Check, X, ChevronRight, ChevronDown, Trash2,
  FileText, Cpu, Package,
} from "lucide-react";
import { fetchJson, errorMessage } from "@/lib/api-client";
import { buildTree } from "../utils";
import { statusVariants, statusLabels, stateVariants, categoryVariants } from "../constants";
import type { BOMItem } from "../types";

interface BomItemsTableProps {
  items: BOMItem[];
  bomId: string;
  /** When false, edit/delete controls are hidden (e.g., after the BOM is RELEASED). */
  isEditable: boolean;
  /** Called after a successful edit or delete so the parent can refresh. */
  onItemsChanged: () => void;
}

/**
 * Renders the items of a single BOM as an indented, collapsible tree.
 *
 * Owns its own edit/collapse state — the parent only needs to pass the
 * raw items, the BOM id, and a refresh callback. This keeps the BOMs
 * page from carrying ~200 lines of table-row JSX inline.
 */
export function BomItemsTable({
  items,
  bomId,
  isEditable,
  onItemsChanged,
}: BomItemsTableProps) {
  const router = useRouter();
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const treeItems = buildTree(items);
  const hasChildren = new Set(items.filter((i) => i.parentItemId).map((i) => i.parentItemId!));

  function toggleCollapse(itemId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  // An item is visible if every ancestor folder is expanded.
  function isVisible(item: BOMItem): boolean {
    if (!item.parentItemId) return true;
    if (collapsed.has(item.parentItemId)) return false;
    const parent = treeItems.find((i) => i.id === item.parentItemId);
    return parent ? isVisible(parent) : true;
  }

  function startEdit(item: BOMItem) {
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

  async function saveEdit() {
    if (!editingItemId) return;
    try {
      await fetchJson(`/api/boms/${bomId}/items`, {
        method: "PUT",
        body: {
          itemId: editingItemId,
          itemNumber: editValues.itemNumber,
          partNumber: editValues.partNumber || null,
          name: editValues.name,
          quantity: parseFloat(editValues.quantity) || 1,
          unit: editValues.unit,
          material: editValues.material || null,
          vendor: editValues.vendor || null,
          unitCost: editValues.unitCost ? parseFloat(editValues.unitCost) : null,
        },
      });
      setEditingItemId(null);
      onItemsChanged();
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to save item");
    }
  }

  async function deleteItem(itemId: string) {
    try {
      await fetchJson(`/api/boms/${bomId}/items`, {
        method: "DELETE",
        body: { itemId },
      });
      toast.success("Item removed");
      onItemsChanged();
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to delete item");
    }
  }

  return (
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
                    <ItemSourceCell item={item} onNavigateToVault={(fid) => router.push(`/vault?fileId=${fid}`)} onNavigateToParts={() => router.push("/parts")} />
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
                            <Button variant="ghost" size="icon-xs" onClick={saveEdit}><Check className="w-3.5 h-3.5 text-green-600" /></Button>
                            <Button variant="ghost" size="icon-xs" onClick={() => setEditingItemId(null)}><X className="w-3.5 h-3.5" /></Button>
                          </>
                        ) : (
                          <>
                            <Button variant="ghost" size="icon-xs" onClick={() => startEdit(item)}><Pencil className="w-3 h-3" /></Button>
                            <Button variant="ghost" size="icon-xs" className="text-destructive" onClick={() => deleteItem(item.id)}><Trash2 className="w-3 h-3" /></Button>
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
  );
}

/**
 * Renders the "source" cell of a BOM item: a linked part, a sub-assembly,
 * a vault file, or a dash. Pulled out so the main row component stays
 * scannable.
 */
function ItemSourceCell({
  item,
  onNavigateToVault,
  onNavigateToParts,
}: {
  item: BOMItem;
  onNavigateToVault: (fileId: string) => void;
  onNavigateToParts: () => void;
}) {
  if (item.part) {
    const part = item.part as BOMItem["part"] & { category: string };
    return (
      <div className="flex items-center gap-1.5">
        <Cpu className="w-3 h-3 text-muted-foreground shrink-0" />
        <button
          className="text-xs hover:underline truncate max-w-28"
          onClick={onNavigateToParts}
          title={item.part.name}
        >
          {item.part.partNumber}
        </button>
        <Badge variant={categoryVariants[part.category] || "secondary"} className="text-[9px] px-1 py-0">
          {part.category.replace("_", " ").toLowerCase()}
        </Badge>
      </div>
    );
  }
  if (item.linkedBom) {
    const linked = item.linkedBom;
    return (
      <div className="flex items-center gap-1.5">
        <Package className="w-3 h-3 text-muted-foreground shrink-0" />
        <span className="text-xs truncate max-w-28">{linked.name}</span>
        <Badge variant={statusVariants[linked.status] || "secondary"} className="text-[9px] px-1 py-0">
          {statusLabels[linked.status]}
        </Badge>
      </div>
    );
  }
  if (item.file) {
    const file = item.file;
    return (
      <div className="flex items-center gap-1.5">
        <FileText className="w-3 h-3 text-muted-foreground shrink-0" />
        <button
          className="text-xs hover:underline truncate max-w-28"
          onClick={() => onNavigateToVault(file.id)}
          title={file.name}
        >
          {file.name}
        </button>
        <Badge variant={stateVariants[file.lifecycleState] || "secondary"} className="text-[9px] px-1 py-0">
          {file.lifecycleState}
        </Badge>
      </div>
    );
  }
  return <span className="text-muted-foreground text-xs">—</span>;
}
