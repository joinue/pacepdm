"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";

interface ImportResult {
  inserted: number;
  updated: number;
  failed: number;
  total: number;
  results: { row: number; partNumber: string; action: "inserted" | "updated" | "failed"; error?: string }[];
}

interface ImportResultsDialogProps {
  result: ImportResult | null;
  onClose: () => void;
}

export function ImportResultsDialog({ result, onClose }: ImportResultsDialogProps) {
  return (
    <Dialog open={!!result} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import results</DialogTitle>
          <DialogDescription>
            {result && (
              <>
                {result.total} row{result.total === 1 ? "" : "s"} processed &middot;{" "}
                <span className="text-green-600 dark:text-green-400 font-medium">{result.inserted} added</span>,{" "}
                <span className="text-blue-600 dark:text-blue-400 font-medium">{result.updated} updated</span>
                {result.failed > 0 && (
                  <>
                    ,{" "}
                    <span className="text-destructive font-medium">{result.failed} failed</span>
                  </>
                )}
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {result && (
          <div className="overflow-y-auto max-h-[50vh] -mx-4 px-4">
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground border-b">
                <tr>
                  <th className="py-1.5 pr-2 w-12">Row</th>
                  <th className="py-1.5 pr-2">Part Number</th>
                  <th className="py-1.5 pr-2 w-24">Action</th>
                  <th className="py-1.5 pr-2">Error</th>
                </tr>
              </thead>
              <tbody>
                {result.results.map((r, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-1.5 pr-2 font-mono text-muted-foreground">{r.row}</td>
                    <td className="py-1.5 pr-2 font-mono">{r.partNumber || "—"}</td>
                    <td className="py-1.5 pr-2">
                      <Badge
                        variant={r.action === "inserted" ? "success" : r.action === "updated" ? "info" : "error"}
                        className="text-[9px] px-1 py-0"
                      >
                        {r.action}
                      </Badge>
                    </td>
                    <td className="py-1.5 pr-2 text-destructive">{r.error || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
