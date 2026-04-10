"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { fetchJson, errorMessage } from "@/lib/api-client";
import type { BOM, CompareResult } from "../types";

interface CompareBomDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  boms: BOM[];
}

/**
 * BOM diff viewer. Lets the user pick two BOMs and renders a side-by-side
 * change report (added/removed/changed items, cost delta).
 *
 * Pre-selects the first two BOMs when opened to save a click in the common case.
 */
export function CompareBomDialog({ open, onOpenChange, boms }: CompareBomDialogProps) {
  const [compareA, setCompareA] = useState("");
  const [compareB, setCompareB] = useState("");
  const [result, setResult] = useState<CompareResult | null>(null);
  const [comparing, setComparing] = useState(false);

  // Pre-fill the picker with the first two BOMs each time the dialog opens.
  useEffect(() => {
    if (open && boms.length >= 2) {
      setCompareA(boms[0].id);
      setCompareB(boms[1].id);
    }
  }, [open, boms]);

  function close() {
    onOpenChange(false);
    setResult(null);
  }

  async function handleCompare() {
    if (!compareA || !compareB || compareA === compareB) return;
    setComparing(true);
    try {
      const data = await fetchJson<CompareResult>(`/api/boms/compare?a=${compareA}&b=${compareB}`);
      setResult(data);
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to compare");
    } finally {
      setComparing(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Compare BOMs</DialogTitle>
          <DialogDescription>Select two BOMs to compare their items side by side.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">BOM A (baseline)</Label>
              <select
                className="w-full h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
                value={compareA}
                onChange={(e) => setCompareA(e.target.value)}
              >
                {boms.map((b) => <option key={b.id} value={b.id}>{b.name} (Rev {b.revision})</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">BOM B (compare to)</Label>
              <select
                className="w-full h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
                value={compareB}
                onChange={(e) => setCompareB(e.target.value)}
              >
                {boms.map((b) => <option key={b.id} value={b.id}>{b.name} (Rev {b.revision})</option>)}
              </select>
            </div>
          </div>
          <Button
            onClick={handleCompare}
            disabled={comparing || !compareA || !compareB || compareA === compareB}
            size="sm"
          >
            {comparing ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Comparing...</> : "Compare"}
          </Button>

          {result && <CompareResultView result={result} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Renders the result of a BOM comparison: summary counts, cost delta,
 * and the per-item changes table. Extracted as a sub-component so the
 * top-level dialog stays focused on form state.
 */
function CompareResultView({ result }: { result: CompareResult }) {
  const visibleChanges = result.changes.filter((c) => c.type !== "unchanged");
  const costDelta = result.bomB.totalCost - result.bomA.totalCost;
  const costDeltaSign = costDelta > 0 ? "+" : "";

  return (
    <div className="space-y-3 mt-2">
      {/* Summary chips */}
      <div className="flex gap-3 text-sm">
        <SummaryChip color="bg-green-500" count={result.summary.added} label="added" />
        <SummaryChip color="bg-red-500" count={result.summary.removed} label="removed" />
        <SummaryChip color="bg-yellow-500" count={result.summary.changed} label="changed" />
        <SummaryChip color="bg-gray-300" count={result.summary.unchanged} label="unchanged" />
      </div>

      {/* Cost delta */}
      <div className="text-sm text-muted-foreground">
        Cost: ${result.bomA.totalCost.toFixed(2)} → ${result.bomB.totalCost.toFixed(2)}
        {costDelta !== 0 && (
          <span className={costDelta > 0 ? "text-red-500 ml-1" : "text-green-500 ml-1"}>
            ({costDeltaSign}{costDelta.toFixed(2)})
          </span>
        )}
      </div>

      {/* Per-item changes table */}
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
            {visibleChanges.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center py-4 text-muted-foreground text-sm">
                  No differences found. The BOMs are identical.
                </TableCell>
              </TableRow>
            ) : (
              visibleChanges.map((change, i) => (
                <TableRow
                  key={i}
                  className={
                    change.type === "added" ? "bg-green-500/5"
                      : change.type === "removed" ? "bg-red-500/5"
                        : "bg-yellow-500/5"
                  }
                >
                  <TableCell>
                    <Badge
                      variant={change.type === "added" ? "success" : change.type === "removed" ? "error" : "warning"}
                      className="text-[9px]"
                    >
                      {change.type}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{change.itemNumber}</TableCell>
                  <TableCell className="text-sm">{change.name}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {change.diffs.join(", ")}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function SummaryChip({ color, count, label }: { color: string; count: number; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full ${color}`} />
      <span>{count} {label}</span>
    </div>
  );
}
