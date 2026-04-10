"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, AlertTriangle, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { fetchJson, errorMessage } from "@/lib/api-client";

interface RollupLine {
  path: string;
  bomId: string;
  bomName: string;
  itemId: string;
  itemNumber: string;
  partNumber: string | null;
  name: string;
  effectiveQuantity: number;
  unit: string;
  unitCost: number | null;
  extendedCost: number | null;
  depth: number;
  isSubAssembly: boolean;
}

interface RollupResponse {
  bomId: string;
  bomName: string;
  bomRevision: string;
  totalCost: number;
  leafItemCount: number;
  totalLineCount: number;
  maxDepth: number;
  itemsMissingCost: number;
  lines: RollupLine[];
}

/**
 * BOM rollup panel — shows totals and a flattened tree walk for the
 * selected BOM. Sub-assemblies are followed via `linkedBomId` and child
 * quantities multiply through (1 frame × 2 wheels × 32 spokes = 64 spokes).
 *
 * Designed to be collapsed by default and only fetched when the user
 * actually opens it — rollup queries can touch dozens of BOMs for a
 * deep tree, and most page loads don't need them.
 */
export function BomRollupPanel({
  bomId,
  /** Bumped by the parent when items change so we know to re-fetch. */
  refreshKey,
}: {
  bomId: string;
  refreshKey?: number;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<RollupResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchJson<RollupResponse>(`/api/boms/${bomId}/rollup`);
      setData(result);
    } catch (err) {
      setError(errorMessage(err) || "Failed to compute rollup");
    } finally {
      setLoading(false);
    }
  }, [bomId]);

  // Reset cached data when the BOM changes or items mutate. The panel
  // re-fetches lazily next time the user opens it — no point in burning
  // a query if they aren't looking.
  useEffect(() => {
    setData(null);
    setError(null);
  }, [bomId, refreshKey]);

  // Auto-load on first open per BOM, but not on every toggle.
  useEffect(() => {
    if (open && !data && !loading && !error) {
      void load();
    }
  }, [open, data, loading, error, load]);

  return (
    <div className="border rounded-lg">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-muted/40 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-muted-foreground" />
          <span className="font-medium text-sm">Rollup (with sub-assemblies)</span>
          {data && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              ${data.totalCost.toFixed(2)}
            </Badge>
          )}
        </div>
        <span className="text-xs text-muted-foreground">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="border-t p-4 space-y-4">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              Computing rollup...
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 rounded p-3">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="space-y-2">
                <p>{error}</p>
                <Button variant="outline" size="sm" onClick={load}>Retry</Button>
              </div>
            </div>
          )}

          {data && !loading && (
            <>
              {/* Aggregate totals */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <Stat label="Total Cost" value={`$${data.totalCost.toFixed(2)}`} />
                <Stat label="Leaf Items" value={data.leafItemCount.toString()} />
                <Stat label="Total Lines" value={data.totalLineCount.toString()} />
                <Stat
                  label="Max Depth"
                  value={data.maxDepth === 0 ? "Flat" : `${data.maxDepth + 1} levels`}
                />
              </div>

              {data.itemsMissingCost > 0 && (
                <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 rounded p-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  {data.itemsMissingCost} item{data.itemsMissingCost !== 1 ? "s" : ""} missing unit cost — totals may be understated.
                </div>
              )}

              {/* Flattened tree walk */}
              {data.lines.length > 0 && (
                <div className="border rounded overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40">
                      <tr className="text-left">
                        <th className="px-2 py-1.5 font-medium">Path</th>
                        <th className="px-2 py-1.5 font-medium">Item</th>
                        <th className="px-2 py-1.5 font-medium text-right">Qty</th>
                        <th className="px-2 py-1.5 font-medium text-right">Unit Cost</th>
                        <th className="px-2 py-1.5 font-medium text-right">Ext. Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.lines.map((line) => (
                        <tr
                          key={`${line.bomId}:${line.itemId}`}
                          className={`border-t ${line.isSubAssembly ? "bg-muted/20 font-medium" : ""}`}
                        >
                          <td className="px-2 py-1 font-mono text-muted-foreground">
                            <span style={{ paddingLeft: `${line.depth * 12}px` }}>{line.path}</span>
                          </td>
                          <td className="px-2 py-1">
                            {line.partNumber && <span className="font-mono text-muted-foreground mr-1.5">{line.partNumber}</span>}
                            {line.name}
                            {line.isSubAssembly && (
                              <Badge variant="outline" className="text-[9px] ml-1.5 px-1 py-0">sub</Badge>
                            )}
                          </td>
                          <td className="px-2 py-1 text-right font-mono">
                            {line.effectiveQuantity} {line.unit}
                          </td>
                          <td className="px-2 py-1 text-right font-mono">
                            {line.unitCost !== null ? `$${line.unitCost.toFixed(2)}` : "—"}
                          </td>
                          <td className="px-2 py-1 text-right font-mono">
                            {line.extendedCost !== null ? `$${line.extendedCost.toFixed(2)}` : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted/30 rounded px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-mono font-semibold">{value}</p>
    </div>
  );
}
