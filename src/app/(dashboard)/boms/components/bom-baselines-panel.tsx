"use client";

// Baselines panel for a BOM — lists immutable release snapshots and
// lets the user view the exact items that were on the BOM at that
// moment. Manual capture is also exposed here (for pre-release freezes
// like "handed off to CM" or "end-of-quarter snapshot").
//
// Read path: GET /api/boms/[bomId]/baselines for the list (cheap, no
// item payload), GET .../baselines/[baselineId] for the full snapshot
// when the user opens one.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { FormattedDate } from "@/components/ui/formatted-date";
import { Archive, Camera, Eye, Loader2 } from "lucide-react";
import { fetchJson, errorMessage } from "@/lib/api-client";
import type { BomSnapshotItem, BomSnapshotMetrics } from "@/lib/bom-snapshot";

interface BaselineListRow {
  id: string;
  bomName: string;
  bomRevision: string;
  bomStatus: string;
  trigger: "RELEASE" | "MANUAL" | "ECO_IMPLEMENT";
  ecoId: string | null;
  snapshotAt: string;
  createdById: string | null;
  createdBy: { fullName: string } | { fullName: string }[] | null;
  note: string | null;
  metrics: BomSnapshotMetrics;
}

interface BaselineDetail {
  id: string;
  bomId: string;
  bomName: string;
  bomRevision: string;
  bomStatus: string;
  trigger: string;
  ecoId: string | null;
  snapshotAt: string;
  note: string | null;
  items: BomSnapshotItem[];
  metrics: BomSnapshotMetrics;
  createdBy: { fullName: string } | { fullName: string }[] | null;
}

interface BomBaselinesPanelProps {
  bomId: string;
  /** Whether the current user can create manual baselines. */
  canCapture: boolean;
}

const TRIGGER_LABELS: Record<string, string> = {
  RELEASE: "Release",
  MANUAL: "Manual",
  ECO_IMPLEMENT: "ECO",
};

const TRIGGER_VARIANTS: Record<string, "success" | "info" | "purple" | "muted"> = {
  RELEASE: "success",
  MANUAL: "info",
  ECO_IMPLEMENT: "purple",
};

export function BomBaselinesPanel({ bomId, canCapture }: BomBaselinesPanelProps) {
  const [baselines, setBaselines] = useState<BaselineListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [showCaptureDialog, setShowCaptureDialog] = useState(false);
  const [captureNote, setCaptureNote] = useState("");
  const [viewingId, setViewingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchJson<BaselineListRow[]>(
        `/api/boms/${bomId}/baselines`
      );
      setBaselines(Array.isArray(data) ? data : []);
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to load baselines");
    } finally {
      setLoading(false);
    }
  }, [bomId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCapture() {
    setCapturing(true);
    try {
      await fetchJson(`/api/boms/${bomId}/baselines`, {
        method: "POST",
        body: { note: captureNote.trim() || null },
      });
      toast.success("Baseline captured");
      setShowCaptureDialog(false);
      setCaptureNote("");
      await load();
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to capture baseline");
    } finally {
      setCapturing(false);
    }
  }

  // The list endpoint comes back with `createdBy` shaped as either an
  // object or a single-element array (Supabase PostgREST join quirk).
  // Normalize for rendering.
  function displayCreator(
    row: { createdBy: { fullName: string } | { fullName: string }[] | null }
  ): string | null {
    const c = row.createdBy;
    if (!c) return null;
    if (Array.isArray(c)) return c[0]?.fullName ?? null;
    return c.fullName;
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Archive className="w-4 h-4 text-muted-foreground" />
            <h4 className="text-sm font-semibold">Baselines</h4>
            <span className="text-xs text-muted-foreground">
              {baselines.length} snapshot{baselines.length === 1 ? "" : "s"}
            </span>
          </div>
          {canCapture && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowCaptureDialog(true)}
              disabled={capturing}
            >
              <Camera className="w-3.5 h-3.5 mr-1.5" />
              Capture baseline
            </Button>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          Baselines are immutable snapshots of the BOM&rsquo;s exact state at a
          moment in time. One is captured automatically whenever the BOM is
          released, and additional snapshots can be taken manually for key
          handoffs.
        </p>

        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          </div>
        ) : baselines.length === 0 ? (
          <div className="text-center py-6 text-xs text-muted-foreground">
            No baselines yet. One will be captured automatically when the BOM is released.
          </div>
        ) : (
          <div className="divide-y rounded-md border">
            {baselines.map((b) => (
              <div
                key={b.id}
                className="flex items-center gap-3 p-3 text-sm hover:bg-muted/30 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge
                      variant={TRIGGER_VARIANTS[b.trigger] || "muted"}
                      className="text-[9px] px-1.5 py-0 shrink-0"
                    >
                      {TRIGGER_LABELS[b.trigger] || b.trigger}
                    </Badge>
                    <span className="font-mono text-xs text-muted-foreground">
                      Rev {b.bomRevision}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {b.metrics.itemCount} item{b.metrics.itemCount === 1 ? "" : "s"}
                    </span>
                    <span className="text-xs text-muted-foreground font-mono">
                      ${b.metrics.flatTotalCost.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                    <FormattedDate date={b.snapshotAt} variant="datetime" />
                    {displayCreator(b) && <span>&middot; {displayCreator(b)}</span>}
                  </div>
                  {b.note && (
                    <p className="text-xs text-muted-foreground italic mt-1">&ldquo;{b.note}&rdquo;</p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setViewingId(b.id)}
                  className="shrink-0"
                >
                  <Eye className="w-3.5 h-3.5 mr-1.5" />
                  View
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={showCaptureDialog} onOpenChange={setShowCaptureDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Capture baseline</DialogTitle>
            <DialogDescription>
              Saves an immutable snapshot of the current BOM items. Add an
              optional note to explain why (e.g. &ldquo;pre-pilot freeze&rdquo;,
              &ldquo;handed off to CM&rdquo;).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label>Note (optional)</Label>
            <Textarea
              value={captureNote}
              onChange={(e) => setCaptureNote(e.target.value)}
              rows={3}
              placeholder="What makes this snapshot worth keeping?"
              maxLength={500}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowCaptureDialog(false)}
              disabled={capturing}
            >
              Cancel
            </Button>
            <Button onClick={handleCapture} disabled={capturing}>
              {capturing && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              Capture
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BaselineViewerDialog
        bomId={bomId}
        baselineId={viewingId}
        onClose={() => setViewingId(null)}
      />
    </Card>
  );
}

// ─── Baseline viewer (modal) ──────────────────────────────────────────

function BaselineViewerDialog({
  bomId,
  baselineId,
  onClose,
}: {
  bomId: string;
  baselineId: string | null;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<BaselineDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!baselineId) {
      queueMicrotask(() => setDetail(null));
      return;
    }
    let cancelled = false;
    queueMicrotask(() => setLoading(true));
    fetchJson<BaselineDetail>(`/api/boms/${bomId}/baselines/${baselineId}`)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err) => {
        if (!cancelled) toast.error(errorMessage(err) || "Failed to load baseline");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bomId, baselineId]);

  return (
    <Dialog open={!!baselineId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            Baseline {detail ? `(Rev ${detail.bomRevision})` : ""}
          </DialogTitle>
          <DialogDescription>
            {detail ? (
              <>
                Captured <FormattedDate date={detail.snapshotAt} variant="datetime" />{" "}
                &middot; {detail.metrics.itemCount} item
                {detail.metrics.itemCount === 1 ? "" : "s"} &middot; $
                {detail.metrics.flatTotalCost.toFixed(2)}
                {detail.note && <> &middot; &ldquo;{detail.note}&rdquo;</>}
              </>
            ) : (
              "Loading…"
            )}
          </DialogDescription>
        </DialogHeader>
        {loading || !detail ? (
          <div className="flex justify-center py-10">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="overflow-y-auto max-h-[60vh] -mx-4 px-4">
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground border-b">
                <tr>
                  <th className="py-1.5 pr-2">#</th>
                  <th className="py-1.5 pr-2">Part / File</th>
                  <th className="py-1.5 pr-2">Name</th>
                  <th className="py-1.5 pr-2 text-right">Qty</th>
                  <th className="py-1.5 pr-2">Unit</th>
                  <th className="py-1.5 pr-2">Rev</th>
                  <th className="py-1.5 pr-2 text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {detail.items.map((item) => {
                  const effectiveCost = item.part?.unitCost ?? item.unitCost ?? null;
                  const rev =
                    item.part?.revision ||
                    item.file?.revision ||
                    item.linkedBom?.revision ||
                    "";
                  const identifier =
                    item.part?.partNumber ||
                    item.partNumber ||
                    item.file?.name ||
                    item.linkedBom?.name ||
                    "—";
                  return (
                    <tr key={item.id} className="border-b last:border-0">
                      <td className="py-1.5 pr-2 font-mono">{item.itemNumber}</td>
                      <td className="py-1.5 pr-2 font-mono truncate max-w-[10rem]">
                        {identifier}
                      </td>
                      <td className="py-1.5 pr-2 truncate max-w-[14rem]">
                        {item.part?.name || item.name}
                      </td>
                      <td className="py-1.5 pr-2 text-right font-mono">
                        {item.quantity}
                      </td>
                      <td className="py-1.5 pr-2">{item.unit}</td>
                      <td className="py-1.5 pr-2 font-mono text-muted-foreground">
                        {rev}
                      </td>
                      <td className="py-1.5 pr-2 text-right font-mono">
                        {effectiveCost != null ? `$${effectiveCost.toFixed(2)}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
