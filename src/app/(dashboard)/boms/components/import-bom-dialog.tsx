"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Upload, FileWarning, CircleCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { SectionLabel } from "@/components/ui/section-label";
import { fetchJson, errorMessage } from "@/lib/api-client";
import { parseBuildList, collectParts } from "@/lib/bom-import";

/**
 * Import a QuickBooks build list, previewing it before anything is written.
 *
 * The preview is the point. `POST /api/boms/import` creates dozens of BOMs
 * and hundreds of parts in one call, and undoing it means deleting them by
 * hand — so the dialog parses the file in the browser first and shows
 * exactly what the run would produce. `src/lib/bom-import.ts` is pure and
 * has no server dependencies, so the preview and the server use the same
 * parser: what you see is what the route will do, not a second
 * approximation of it that can drift.
 *
 * Three states: choose a file → review the parse → review the result.
 */

interface BomResult {
  partNumber: string;
  status: "created" | "skipped";
  reason?: string;
  itemCount?: number;
}

interface ImportSummary {
  bomsCreated: number;
  bomsSkipped: number;
  partsCreated: number;
  partsUpdated: number;
  itemsCreated: number;
  optionItems: number;
  results: BomResult[];
  problems: { line: number; message: string }[];
  warnings: string[];
}

interface Preview {
  fileName: string;
  csvText: string;
  bomCount: number;
  itemCount: number;
  partCount: number;
  optionCount: number;
  problems: { line: number; message: string }[];
}

interface ImportBomDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once after a run that created at least one BOM. */
  onImported: () => void;
}

const MAX_BYTES = 5 * 1024 * 1024;

export function ImportBomDialog({ open, onOpenChange, onImported }: ImportBomDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [importing, setImporting] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  function reset() {
    setPreview(null);
    setSummary(null);
    setReadError(null);
    setImporting(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  function close() {
    onOpenChange(false);
    reset();
  }

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setReadError(null);
    setSummary(null);

    if (file.size > MAX_BYTES) {
      setReadError("That file is larger than 5 MB. Check it is a build list export.");
      setPreview(null);
      return;
    }

    let csvText: string;
    try {
      csvText = await file.text();
    } catch (err) {
      setReadError(errorMessage(err));
      setPreview(null);
      return;
    }

    const parsed = parseBuildList(csvText);
    if (parsed.boms.length === 0) {
      setReadError(
        "No BOM rows found. The first column of each row must be `BOM` or `Item` — this may not be a build list export."
      );
      setPreview(null);
      return;
    }

    const items = parsed.boms.flatMap((b) => b.items);
    setPreview({
      fileName: file.name,
      csvText,
      bomCount: parsed.boms.length,
      itemCount: items.length,
      partCount: collectParts(parsed).size,
      optionCount: items.filter((i) => i.optionGroup !== null).length,
      problems: parsed.problems,
    });
  }

  async function handleImport() {
    if (!preview) return;
    setImporting(true);
    try {
      const result = await fetchJson<ImportSummary>("/api/boms/import", {
        method: "POST",
        body: preview.csvText,
        // Overrides the JSON default in fetchJson; the route reads the body
        // as text unless it is multipart.
        headers: { "Content-Type": "text/csv" },
      });
      setSummary(result);
      if (result.bomsCreated > 0) {
        toast.success(`Imported ${result.bomsCreated} BOM${result.bomsCreated === 1 ? "" : "s"}`);
        onImported();
      } else {
        toast.info("Nothing imported — every BOM in the file already exists");
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import build list</DialogTitle>
          <DialogDescription>
            Upload a QuickBooks build list CSV. One file can define many BOMs; sub-assemblies are
            linked automatically where a line&apos;s part number matches another BOM in the file.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {!summary && (
            <div className="space-y-2">
              <Label htmlFor="build-list-file">Build list CSV</Label>
              <input
                ref={inputRef}
                id="build-list-file"
                type="file"
                accept=".csv,text/csv"
                onChange={handleFile}
                disabled={importing}
                className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground hover:file:bg-accent disabled:opacity-50"
              />
            </div>
          )}

          {readError && (
            <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
              <FileWarning className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
              <span>{readError}</span>
            </p>
          )}

          {preview && !summary && (
            <div className="space-y-3" aria-live="polite">
              <SectionLabel>Preview — nothing has been saved yet</SectionLabel>
              <p className="text-sm text-muted-foreground">{preview.fileName}</p>
              <StatGrid
                stats={[
                  { label: "BOMs", value: preview.bomCount },
                  { label: "Lines", value: preview.itemCount },
                  { label: "Parts", value: preview.partCount },
                  { label: "Option lines", value: preview.optionCount },
                ]}
              />
              <p className="text-xs text-muted-foreground">
                A BOM whose name already exists is skipped, so re-importing the same file is safe.
                Parts are matched by part number and updated rather than duplicated.
              </p>
              {preview.problems.length > 0 && (
                <IssueList
                  title={`${preview.problems.length} row${preview.problems.length === 1 ? "" : "s"} cannot be imported`}
                  items={preview.problems.map((p) => `Line ${p.line}: ${p.message}`)}
                  footer="Everything else in the file will still import."
                />
              )}
            </div>
          )}

          {summary && (
            <div className="space-y-3" aria-live="polite">
              <SectionLabel>Result</SectionLabel>
              <StatGrid
                stats={[
                  { label: "BOMs created", value: summary.bomsCreated },
                  { label: "BOMs skipped", value: summary.bomsSkipped },
                  { label: "Parts created", value: summary.partsCreated },
                  { label: "Parts updated", value: summary.partsUpdated },
                  { label: "Lines", value: summary.itemsCreated },
                  { label: "Option lines", value: summary.optionItems },
                ]}
              />

              {summary.warnings.length > 0 && (
                <IssueList title="Warnings" items={summary.warnings} />
              )}
              {summary.problems.length > 0 && (
                <IssueList
                  title={`${summary.problems.length} row${summary.problems.length === 1 ? "" : "s"} skipped`}
                  items={summary.problems.map((p) => `Line ${p.line}: ${p.message}`)}
                />
              )}

              <div className="max-h-48 overflow-y-auto rounded-md border border-border">
                <ul className="divide-y divide-border">
                  {summary.results.map((r) => (
                    <li
                      key={r.partNumber}
                      className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm"
                    >
                      <span className="truncate font-medium">{r.partNumber}</span>
                      {r.status === "created" ? (
                        <span className="flex shrink-0 items-center gap-1 text-xs text-success">
                          <CircleCheck className="w-3.5 h-3.5" aria-hidden="true" />
                          {r.itemCount} line{r.itemCount === 1 ? "" : "s"}
                        </span>
                      ) : (
                        <span className="shrink-0 text-xs text-muted-foreground" title={r.reason}>
                          Skipped
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              <p className="text-xs text-muted-foreground">
                Imported BOMs start in <strong>Draft</strong>. Costs are empty until an item master
                is imported from Parts — the build list carries structure only.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          {summary ? (
            <>
              <Button variant="outline" onClick={reset}>
                Import another
              </Button>
              <Button onClick={close}>Done</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={close} disabled={importing}>
                Cancel
              </Button>
              <Button onClick={handleImport} disabled={!preview || importing}>
                <Upload className="w-4 h-4 mr-2" aria-hidden="true" />
                {importing
                  ? "Importing..."
                  : preview
                    ? `Import ${preview.bomCount} BOM${preview.bomCount === 1 ? "" : "s"}`
                    : "Import"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatGrid({ stats }: { stats: { label: string; value: number }[] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
      {stats.map((s) => (
        <div key={s.label} className="rounded-md bg-muted/50 px-3 py-2">
          <dt className="text-xs text-muted-foreground">{s.label}</dt>
          <dd className="text-lg font-semibold tabular-nums">{s.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Non-fatal issues — rows that will not import, or facts about the run the
 * user should see. Never an error state: the import proceeds regardless, so
 * this is warning-toned rather than destructive.
 */
function IssueList({ title, items, footer }: { title: string; items: string[]; footer?: string }) {
  return (
    <div className="rounded-md border border-warning/40 bg-warning/5 p-3">
      <p className="flex items-center gap-2 text-sm font-medium text-warning">
        <TriangleAlert className="w-4 h-4 shrink-0" aria-hidden="true" />
        {title}
      </p>
      <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto text-xs text-muted-foreground">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
      {footer && <p className="mt-2 text-xs text-muted-foreground">{footer}</p>}
    </div>
  );
}
