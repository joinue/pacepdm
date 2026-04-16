"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Loader2, Layers, ChevronDown, ChevronRight } from "lucide-react";
import { fetchJson } from "@/lib/api-client";
import Link from "next/link";

interface AffectedBomItem {
  itemNumber: string;
  partNumber: string;
  partName: string;
  currentRevision: string;
  toRevision: string;
  quantity: number;
  unitCost: number | null;
}

interface AffectedBom {
  bomId: string;
  bomName: string;
  bomRevision: string | null;
  bomStatus: string;
  affectedItems: AffectedBomItem[];
  totalItems: number;
}

interface BomImpactData {
  affectedBoms: AffectedBom[];
  summary: { totalBoms: number; totalItemsAffected: number };
}

/**
 * Shows the downstream BOM impact of an ECO: which BOMs contain parts
 * affected by this ECO, and which line items will see a revision bump.
 * Renders inline in the ECO detail panel between the status transition
 * buttons and the tabs.
 *
 * Loads on mount, collapses when there's no impact, and auto-expands
 * when there are affected BOMs so reviewers see the impact immediately.
 */
export function EcoBomImpact({ ecoId }: { ecoId: string }) {
  const [data, setData] = useState<BomImpactData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedBoms, setExpandedBoms] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchJson<BomImpactData>(
        `/api/ecos/${ecoId}/bom-impact`
      );
      setData(result);
      // Auto-expand if only 1-2 BOMs affected (common case).
      if (result.affectedBoms.length <= 2) {
        setExpandedBoms(new Set(result.affectedBoms.map((b) => b.bomId)));
      }
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [ecoId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
        <Loader2 className="w-3 h-3 animate-spin" />
        Checking BOM impact...
      </div>
    );
  }

  if (!data || data.summary.totalBoms === 0) return null;

  function toggleBom(bomId: string) {
    setExpandedBoms((prev) => {
      const next = new Set(prev);
      if (next.has(bomId)) next.delete(bomId);
      else next.add(bomId);
      return next;
    });
  }

  return (
    <div className="rounded-lg border border-border bg-card/50 overflow-hidden">
      {/* Header summary */}
      <div className="flex items-center gap-2 px-3 py-2.5 bg-muted/30">
        <Layers className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">BOM Impact</span>
        <Badge variant="secondary" className="text-[9px] px-1.5 py-0">
          {data.summary.totalBoms} BOM{data.summary.totalBoms !== 1 ? "s" : ""}
        </Badge>
        <span className="text-[11px] text-muted-foreground">
          {data.summary.totalItemsAffected} item{data.summary.totalItemsAffected !== 1 ? "s" : ""} affected
        </span>
      </div>

      {/* Per-BOM sections */}
      {data.affectedBoms.map((bom) => {
        const isExpanded = expandedBoms.has(bom.bomId);
        return (
          <div key={bom.bomId} className="border-t border-border/60">
            <button
              onClick={() => toggleBom(bom.bomId)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/20 transition-colors"
            >
              {isExpanded
                ? <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
                : <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
              }
              <Link
                href={`/boms/${bom.bomId}`}
                onClick={(e) => e.stopPropagation()}
                className="text-xs font-medium hover:underline truncate"
              >
                {bom.bomName}
              </Link>
              {bom.bomRevision && (
                <span className="text-[10px] font-mono text-muted-foreground">
                  Rev {bom.bomRevision}
                </span>
              )}
              <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                {bom.affectedItems.length} of {bom.totalItems} items
              </span>
            </button>

            {isExpanded && (
              <div className="px-3 pb-2.5">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      <th className="text-left py-1 pr-2 font-medium">Item</th>
                      <th className="text-left py-1 pr-2 font-medium">Part #</th>
                      <th className="text-left py-1 pr-2 font-medium">Name</th>
                      <th className="text-right py-1 pr-2 font-medium">Qty</th>
                      <th className="text-left py-1 font-medium">Rev change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bom.affectedItems.map((item, i) => (
                      <tr key={i} className="border-t border-border/40">
                        <td className="py-1.5 pr-2 font-mono">{item.itemNumber}</td>
                        <td className="py-1.5 pr-2 font-mono">{item.partNumber}</td>
                        <td className="py-1.5 pr-2 truncate max-w-32">{item.partName}</td>
                        <td className="py-1.5 pr-2 text-right">{item.quantity}</td>
                        <td className="py-1.5">
                          <span className="text-muted-foreground">{item.currentRevision}</span>
                          <span className="text-muted-foreground mx-1">&rarr;</span>
                          <span className="font-medium text-foreground">{item.toRevision}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
