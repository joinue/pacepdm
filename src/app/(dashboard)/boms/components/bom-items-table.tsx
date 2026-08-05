"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Pencil,
  Check,
  X,
  ChevronRight,
  ChevronDown,
  Trash2,
  FileText,
  Cpu,
  Package,
} from "lucide-react";
import { fetchJson, errorMessage } from "@/lib/api-client";
import { EntityThumbnail, type ThumbnailKind } from "@/components/ui/entity-thumbnail";
import { buildTree } from "../utils";
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
export function BomItemsTable({ items, bomId, isEditable, onItemsChanged }: BomItemsTableProps) {
  const router = useRouter();
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const treeItems = buildTree(items);
  const hasChildren = new Set(items.filter((i) => i.parentItemId).map((i) => i.parentItemId!));

  // When a BOM item is linked to a part, display fields come from the
  // live part record (via the `part:parts!...` join) instead of the
  // per-row snapshot columns. That way a renamed or rev-bumped part
  // propagates to every BOM without a backfill. The snapshot still wins
  // for free-text items and for rows whose part was later deleted.
  const displayOf = (item: BOMItem) => ({
    partNumber: item.part?.partNumber ?? item.partNumber ?? item.file?.partNumber ?? null,
    name: item.part?.name ?? item.name,
    material: item.part?.material ?? item.material,
    unit: item.part?.unit ?? item.unit,
    unitCost: item.part?.unitCost ?? item.unitCost,
    // Sub-assembly first, matching ItemSourceCell's precedence: a line that
    // carries both a linkedBomId and a partId *is* the sub-assembly, and its
    // own picture is the more useful of the two.
    thumbnailUrl: item.linkedBom?.thumbnailUrl ?? item.part?.thumbnailUrl ?? null,
    thumbnailKind: (item.linkedBom ? "bom" : "part") as ThumbnailKind,
  });

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
            {/* Unlabelled: the pictures are the label. Same leading-image
                column the parts list uses. */}
            <TableHead className="w-10" />
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
              <TableCell
                colSpan={isEditable ? 12 : 11}
                className="text-center py-12 text-muted-foreground"
              >
                <Package className="w-8 h-8 mx-auto mb-2 opacity-30" />
                No items yet. {isEditable ? 'Click "Add Item" to add parts.' : ""}
              </TableCell>
            </TableRow>
          ) : (
            treeItems.filter(isVisible).map((item) => {
              const isEditing = editingItemId === item.id;
              const hasKids = hasChildren.has(item.id);
              const isCollapsed = collapsed.has(item.id);

              const display = displayOf(item);
              const extCost = display.unitCost != null ? display.unitCost * item.quantity : null;

              return (
                <TableRow key={item.id} className={item.level > 0 ? "bg-muted/20" : ""}>
                  {/* The line's picture — from the sub-assembly it points at,
                      or from the linked part. Free-text lines get the
                      placeholder tile, which keeps the column aligned. */}
                  <TableCell>
                    <EntityThumbnail
                      src={display.thumbnailUrl}
                      kind={display.thumbnailKind}
                      size="sm"
                    />
                  </TableCell>

                  {/* Item # with tree indent */}
                  <TableCell className="font-mono text-xs">
                    <div
                      className="flex items-center"
                      style={{ paddingLeft: `${item.level * 16}px` }}
                    >
                      {hasKids ? (
                        <button
                          onClick={() => toggleCollapse(item.id)}
                          className="mr-1 p-0.5 hover:bg-muted rounded"
                        >
                          {isCollapsed ? (
                            <ChevronRight className="w-3 h-3" />
                          ) : (
                            <ChevronDown className="w-3 h-3" />
                          )}
                        </button>
                      ) : item.level > 0 ? (
                        <span className="w-4 mr-1 inline-block text-center text-muted-foreground">
                          ·
                        </span>
                      ) : null}
                      {isEditing ? (
                        <Input
                          value={editValues.itemNumber}
                          onChange={(e) =>
                            setEditValues({ ...editValues, itemNumber: e.target.value })
                          }
                          className="h-6 w-14 text-xs px-1"
                        />
                      ) : (
                        item.itemNumber
                      )}
                    </div>
                  </TableCell>

                  {/* Name */}
                  <TableCell className="font-medium text-sm">
                    {isEditing ? (
                      <Input
                        value={editValues.name}
                        onChange={(e) => setEditValues({ ...editValues, name: e.target.value })}
                        className="h-6 text-xs px-1"
                      />
                    ) : (
                      <span className="inline-flex items-center gap-1.5">
                        {display.name}
                        {/* One variant of a configure-to-order group. Marked
                            because the BOM lists every variant side by side —
                            without this, a 110V and a 220V line are
                            indistinguishable and the list reads as if both
                            ship. Excluded from the base rollup total. */}
                        {item.optionGroup && (
                          <Badge
                            variant="secondary"
                            className="text-4xs px-1 py-0 font-normal"
                            title={item.optionPrompt ?? `Option: ${item.optionGroup}`}
                          >
                            {item.optionGroup}
                          </Badge>
                        )}
                      </span>
                    )}
                  </TableCell>

                  {/* Part # */}
                  <TableCell className="text-sm">
                    {isEditing ? (
                      <Input
                        value={editValues.partNumber}
                        onChange={(e) =>
                          setEditValues({ ...editValues, partNumber: e.target.value })
                        }
                        className="h-6 text-xs px-1"
                      />
                    ) : (
                      display.partNumber || "—"
                    )}
                  </TableCell>

                  {/* Qty */}
                  <TableCell className="text-sm">
                    {isEditing ? (
                      <Input
                        type="number"
                        value={editValues.quantity}
                        onChange={(e) => setEditValues({ ...editValues, quantity: e.target.value })}
                        className="h-6 w-16 text-xs px-1"
                        min="0"
                        step="any"
                      />
                    ) : (
                      item.quantity
                    )}
                  </TableCell>

                  {/* Unit */}
                  <TableCell className="text-xs">
                    {isEditing ? (
                      <Input
                        value={editValues.unit}
                        onChange={(e) => setEditValues({ ...editValues, unit: e.target.value })}
                        className="h-6 w-12 text-xs px-1"
                      />
                    ) : (
                      display.unit
                    )}
                  </TableCell>

                  {/* Source: part / sub-assembly / file */}
                  <TableCell className="text-sm">
                    <ItemSourceCell
                      item={item}
                      onNavigateToVault={(fid) => router.push(`/vault?fileId=${fid}`)}
                      // The parts page already supports ?partId= deep links;
                      // this was throwing the id away and landing on the list.
                      onNavigateToParts={(pid) => router.push(`/parts?partId=${pid}`)}
                      onNavigateToBom={(bid) => router.push(`/boms/${bid}`)}
                    />
                  </TableCell>

                  {/* Material */}
                  <TableCell className="text-sm">
                    {isEditing ? (
                      <Input
                        value={editValues.material}
                        onChange={(e) => setEditValues({ ...editValues, material: e.target.value })}
                        className="h-6 text-xs px-1"
                      />
                    ) : (
                      display.material || "—"
                    )}
                  </TableCell>

                  {/* Vendor — stays on the snapshot: parts don't have a
                      vendor column of their own (primary vendor is a
                      relation), so there's nothing live to prefer. */}
                  <TableCell className="text-sm">
                    {isEditing ? (
                      <Input
                        value={editValues.vendor}
                        onChange={(e) => setEditValues({ ...editValues, vendor: e.target.value })}
                        className="h-6 text-xs px-1"
                      />
                    ) : (
                      item.vendor || "—"
                    )}
                  </TableCell>

                  {/* Unit Cost */}
                  <TableCell className="font-mono text-sm">
                    {isEditing ? (
                      <Input
                        type="number"
                        value={editValues.unitCost}
                        onChange={(e) => setEditValues({ ...editValues, unitCost: e.target.value })}
                        className="h-6 w-20 text-xs px-1"
                        min="0"
                        step="0.01"
                      />
                    ) : display.unitCost != null ? (
                      `$${display.unitCost.toFixed(2)}`
                    ) : (
                      "—"
                    )}
                  </TableCell>

                  {/* Ext. Cost */}
                  <TableCell className="font-mono text-sm">
                    {extCost != null ? `$${extCost.toFixed(2)}` : "—"}
                  </TableCell>

                  {/* Actions */}
                  {isEditable && (
                    <TableCell>
                      <div className="flex items-center gap-0.5">
                        {isEditing ? (
                          <>
                            <Button variant="ghost" size="icon-xs" onClick={saveEdit}>
                              <Check className="w-3.5 h-3.5 text-success" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              onClick={() => setEditingItemId(null)}
                            >
                              <X className="w-3.5 h-3.5" />
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button variant="ghost" size="icon-xs" onClick={() => startEdit(item)}>
                              <Pencil className="w-3 h-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              className="text-destructive"
                              onClick={() => deleteItem(item.id)}
                            >
                              <Trash2 className="w-3 h-3" />
                            </Button>
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
 * Renders the "source" cell of a BOM item: a sub-assembly, a linked part, a
 * vault file, or a dash. Pulled out so the main row component stays
 * scannable, and exported so the precedence below can be tested — it is the
 * kind of rule that regresses silently.
 *
 * **Sub-assembly wins over part, and that ordering is the point.** An
 * imported sub-assembly line carries both: `linkedBomId` for the structure
 * and `partId` so the line resolves to a real item for the eventual ERP
 * push. Checking `part` first — as this did — meant every one of the
 * NANO-1000S's 22 sub-assembly lines rendered as an ordinary part and sent
 * you to the parts list, with no way to open the assembly the line actually
 * points at.
 */
export function ItemSourceCell({
  item,
  onNavigateToVault,
  onNavigateToParts,
  onNavigateToBom,
}: {
  item: BOMItem;
  onNavigateToVault: (fileId: string) => void;
  onNavigateToParts: (partId: string) => void;
  onNavigateToBom: (bomId: string) => void;
}) {
  if (item.linkedBom) {
    const linked = item.linkedBom;
    return (
      <div className="flex items-center gap-1.5">
        <Package className="w-3 h-3 text-muted-foreground shrink-0" />
        <button
          className="text-xs hover:underline truncate max-w-28"
          onClick={() => onNavigateToBom(linked.id)}
          title={`Open ${linked.name} · Rev ${linked.revision}`}
        >
          {linked.name}
        </button>
        <span className="text-3xs font-mono text-muted-foreground">Rev {linked.revision}</span>
        <StatusBadge status={linked.status} kind="bom" className="text-4xs px-1 py-0" />
      </div>
    );
  }
  if (item.part) {
    const part = item.part;
    return (
      <div className="flex items-center gap-1.5">
        <Cpu className="w-3 h-3 text-muted-foreground shrink-0" />
        <button
          className="text-xs hover:underline truncate max-w-28"
          onClick={() => onNavigateToParts(part.id)}
          title={`${part.name} · Rev ${part.revision}`}
        >
          {part.partNumber}
        </button>
        <span className="text-3xs font-mono text-muted-foreground">Rev {part.revision}</span>
        <StatusBadge status={part.category} kind="bom" className="text-4xs px-1 py-0" />
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
        <StatusBadge status={file.lifecycleState} kind="lifecycle" className="text-4xs px-1 py-0" />
      </div>
    );
  }
  return <span className="text-muted-foreground text-xs">—</span>;
}
