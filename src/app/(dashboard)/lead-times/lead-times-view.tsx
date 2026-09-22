"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { FormattedDate } from "@/components/ui/formatted-date";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { History, Loader2, Plus, Search, Clock, Download } from "lucide-react";
import { useFetch } from "@/hooks/use-fetch";
import { usePermissions } from "@/hooks/use-permissions";
import { useRealtimeTable } from "@/hooks/use-realtime-table";
import { useRealtimeEchoGuard } from "@/hooks/use-realtime-echo-guard";
import { useTenantUser } from "@/components/providers/tenant-provider";
import { fetchJson, errorMessage } from "@/lib/api-client";
import { PERMISSIONS } from "@/lib/permissions";
import {
  LEAD_TIME_OPTIONS,
  LEAD_TIME_STALE_DAYS,
  describeFreshness,
  leadTimeFreshness,
} from "@/lib/lead-times";

/**
 * What sales quotes, and when engineering last said it.
 *
 * Replaces a shared spreadsheet. The three things it does that the sheet could
 * not: who changed a value and when is stamped rather than typed, a value
 * nobody has touched for a month is marked stale instead of being quoted as
 * though it were current, and a change someone else makes appears here without
 * a refresh — sales leaves this page open while quoting.
 */

interface LeadTimeRow {
  id: string;
  model: string;
  description: string | null;
  typicalLeadTime: string | null;
  currentLeadTime: string | null;
  notes: string | null;
  updatedAt: string | null;
  // A to-one join, which the Supabase client types as an array.
  updatedBy: { fullName: string | null } | { fullName: string | null }[] | null;
}

interface Change {
  id: string;
  fromLeadTime: string | null;
  toLeadTime: string | null;
  note: string | null;
  changedAt: string;
  changedBy: { fullName: string | null } | { fullName: string | null }[] | null;
}

function personName(who: LeadTimeRow["updatedBy"]): string | null {
  const one = Array.isArray(who) ? who[0] : who;
  return one?.fullName ?? null;
}

/**
 * The list as a CSV, for the quote someone is building right now.
 *
 * Sales still works in spreadsheets, and a page they cannot get a copy out of
 * sends them back to emailing engineering for one. Exports what is on screen,
 * filters included, with the two stamped columns the old sheet asked people to
 * type.
 */
function exportCsv(rows: LeadTimeRow[]) {
  const cell = (value: string | null) => `"${(value ?? "").replace(/"/g, '""')}"`;
  const header = [
    "Model",
    "Description",
    "Typical Lead Time",
    "Current Lead Time",
    "Notes",
    "Last updated",
    "Updated by",
  ];
  const lines = rows.map((r) =>
    [
      r.model,
      r.description,
      r.typicalLeadTime,
      r.currentLeadTime,
      r.notes,
      describeFreshness(r),
      personName(r.updatedBy),
    ]
      .map(cell)
      .join(",")
  );

  const csv = [header.map(cell).join(","), ...lines].join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `lead-times-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * The lead-time dropdown, in the sheet's own words.
 *
 * Used for both columns. Typical is the baseline for a machine and changes
 * rarely; current is what sales quotes today, and is the one that writes
 * history and tells the workspace — see the PUT route.
 */
function LeadTimePicker({
  value,
  disabled,
  subdued,
  label,
  onChange,
}: {
  value: string | null;
  disabled: boolean;
  subdued?: boolean;
  label: string;
  onChange: (next: string | null) => void;
}) {
  return (
    <Select value={value ?? ""} onValueChange={(v) => onChange(v ?? null)}>
      <SelectTrigger
        aria-label={label}
        disabled={disabled}
        className={subdued ? "w-32 text-muted-foreground" : "w-36"}
      >
        <SelectValue placeholder="Not set">{(v) => (v ? String(v) : "Not set")}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {LEAD_TIME_OPTIONS.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** "Not set yet" / "Updated 3 days ago", plus the tone that goes with it. */
function FreshnessBadge({ row }: { row: LeadTimeRow }) {
  const freshness = leadTimeFreshness(row);
  const label = describeFreshness(row);
  if (freshness === "fresh") return <span className="text-xs text-muted-foreground">{label}</span>;
  return (
    <Badge variant={freshness === "stale" ? "warning" : "muted"}>
      {freshness === "stale" ? `${label} — confirm` : label}
    </Badge>
  );
}

export function LeadTimesView() {
  const { can } = usePermissions();
  const canEdit = can(PERMISSIONS.LEAD_TIME_EDIT);
  const user = useTenantUser();

  const { data, loading, error, setData, refetch } = useFetch<{ leadTimes: LeadTimeRow[] }>(
    "/api/lead-times"
  );
  const rows = useMemo(() => data?.leadTimes ?? [], [data]);

  const [query, setQuery] = useState("");
  const [needsAttention, setNeedsAttention] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [historyFor, setHistoryFor] = useState<LeadTimeRow | null>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (needsAttention && leadTimeFreshness(r) === "fresh") return false;
      if (!q) return true;
      return (
        r.model.toLowerCase().includes(q) ||
        (r.description ?? "").toLowerCase().includes(q) ||
        (r.notes ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, query, needsAttention]);

  const staleCount = rows.filter((r) => leadTimeFreshness(r) === "stale").length;
  const unsetCount = rows.filter((r) => leadTimeFreshness(r) === "unset").length;
  const attentionCount = staleCount + unsetCount;

  // Someone else's change lands here. The guard keeps our own write from
  // costing a second fetch, since `save` already patches the row it changed.
  const { markLocalWrite, isEcho } = useRealtimeEchoGuard();
  useRealtimeTable({
    table: "equipment_lead_times",
    filter: `tenantId=eq.${user.tenantId}`,
    onChange: () => {
      if (isEcho()) return;
      void refetch();
    },
  });

  /** Row-scoped optimistic patch, rolled back on failure. */
  function patchRow(id: string, patch: Partial<LeadTimeRow>) {
    setData((prev) =>
      prev
        ? { ...prev, leadTimes: prev.leadTimes.map((r) => (r.id === id ? { ...r, ...patch } : r)) }
        : prev
    );
  }

  async function save(row: LeadTimeRow, patch: Partial<LeadTimeRow>) {
    const before = { ...row };
    markLocalWrite();
    setSavingId(row.id);
    patchRow(row.id, patch);
    try {
      const updated = await fetchJson<LeadTimeRow>(`/api/lead-times/${row.id}`, {
        method: "PUT",
        body: patch,
      });
      patchRow(row.id, updated);
    } catch (err) {
      patchRow(row.id, before);
      toast.error(errorMessage(err));
    } finally {
      setSavingId(null);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title="Equipment Lead Times"
        description="What sales quotes today, and who last said so."
        actions={
          canEdit ? (
            <Button size="sm" onClick={() => setShowAdd(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Add equipment
            </Button>
          ) : null
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by model, description or note..."
            className="pl-8"
          />
        </div>
        {attentionCount > 0 && (
          <Button
            variant={needsAttention ? "default" : "outline"}
            size="sm"
            aria-pressed={needsAttention}
            onClick={() => setNeedsAttention((on) => !on)}
          >
            {`${attentionCount} need${attentionCount === 1 ? "s" : ""} attention`}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => exportCsv(shown)}>
          <Download className="w-4 h-4 mr-2" />
          Export
        </Button>
      </div>

      {attentionCount > 0 && (
        <p className="text-xs text-muted-foreground">
          {staleCount > 0 && `${staleCount} older than ${LEAD_TIME_STALE_DAYS} days`}
          {staleCount > 0 && unsetCount > 0 && " · "}
          {unsetCount > 0 && `${unsetCount} never set`}
        </p>
      )}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-11 w-full" />
          ))}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-destructive">
            {errorMessage(error)}
          </CardContent>
        </Card>
      ) : shown.length === 0 ? (
        <EmptyState
          icon={Clock}
          title={
            needsAttention
              ? "Every lead time is current"
              : query
                ? "No equipment matches that"
                : "No equipment yet"
          }
          description={
            needsAttention
              ? `Nothing is unset or older than ${LEAD_TIME_STALE_DAYS} days.`
              : query
                ? "Try a different model or description."
                : "Add the machines sales quotes, and their lead times."
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Typical</TableHead>
                <TableHead>Current (quoted)</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead>Last updated</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((row) => {
                const who = personName(row.updatedBy);
                return (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-xs font-medium">{row.model}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.description}
                    </TableCell>
                    <TableCell>
                      {canEdit ? (
                        <LeadTimePicker
                          subdued
                          label={`Typical lead time for ${row.model}`}
                          value={row.typicalLeadTime}
                          disabled={savingId === row.id}
                          onChange={(v) => void save(row, { typicalLeadTime: v })}
                        />
                      ) : (
                        <span className="text-sm text-muted-foreground">
                          {row.typicalLeadTime ?? "—"}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {canEdit ? (
                        <LeadTimePicker
                          label={`Current lead time for ${row.model}`}
                          value={row.currentLeadTime}
                          disabled={savingId === row.id}
                          onChange={(v) => void save(row, { currentLeadTime: v })}
                        />
                      ) : (
                        <span className="text-sm font-medium">{row.currentLeadTime ?? "—"}</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-56">
                      {canEdit ? (
                        <Input
                          defaultValue={row.notes ?? ""}
                          placeholder="Backorder, special build..."
                          className="h-8 text-xs"
                          onBlur={(e) => {
                            const next = e.target.value.trim();
                            if (next !== (row.notes ?? "")) void save(row, { notes: next || null });
                          }}
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground">{row.notes}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <FreshnessBadge row={row} />
                        {who && (
                          <span className="text-2xs text-muted-foreground">
                            {who}
                            {row.updatedAt && (
                              <>
                                {" · "}
                                <FormattedDate date={row.updatedAt} variant="date" />
                              </>
                            )}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      {savingId === row.id ? (
                        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          aria-label={`History for ${row.model}`}
                          onClick={() => setHistoryFor(row)}
                        >
                          <History className="w-4 h-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <AddEquipmentDialog
        open={showAdd}
        onOpenChange={setShowAdd}
        onAdded={() => {
          markLocalWrite();
          void refetch();
        }}
      />
      <HistorySheet row={historyFor} onClose={() => setHistoryFor(null)} />
    </PageContainer>
  );
}

function AddEquipmentDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const [model, setModel] = useState("");
  const [description, setDescription] = useState("");
  const [typical, setTypical] = useState<string>("4 weeks");
  const [saving, setSaving] = useState(false);

  function close() {
    setModel("");
    setDescription("");
    setTypical("4 weeks");
    onOpenChange(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!model.trim() || saving) return;
    setSaving(true);
    try {
      await fetchJson("/api/lead-times", {
        method: "POST",
        body: {
          model: model.trim(),
          description: description.trim() || null,
          typicalLeadTime: typical,
        },
      });
      toast.success(`${model.trim()} added`);
      onAdded();
      close();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Add equipment</DialogTitle>
            <DialogDescription>
              A machine sales quotes. Its current lead time is set on the list.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="lead-time-model">Model</Label>
              <Input
                id="lead-time-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="MEGA-T300A"
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lead-time-description">Description</Label>
              <Input
                id="lead-time-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder='Automated Abrasive Cutter - 12"'
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lead-time-typical">Typical lead time</Label>
              <Select value={typical} onValueChange={(v) => setTypical(v ?? "")}>
                <SelectTrigger id="lead-time-typical" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LEAD_TIME_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={!model.trim() || saving}>
              {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function HistorySheet({ row, onClose }: { row: LeadTimeRow | null; onClose: () => void }) {
  const { data, loading } = useFetch<{ changes: Change[] }>(
    row ? `/api/lead-times/${row.id}` : null
  );
  const changes = data?.changes ?? [];

  return (
    <Sheet open={!!row} onOpenChange={(open) => !open && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{row?.model}</SheetTitle>
          <SheetDescription>What we have told sales, and when.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4 space-y-3">
          {loading ? (
            <Skeleton className="h-16 w-full" />
          ) : changes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No changes recorded yet. The first time someone sets this lead time, it shows here.
            </p>
          ) : (
            changes.map((change) => (
              <div key={change.id} className="rounded-lg border border-border p-3 text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground line-through">
                    {change.fromLeadTime ?? "Not set"}
                  </span>
                  <span className="font-medium">{change.toLeadTime ?? "Not set"}</span>
                </div>
                <p className="text-2xs text-muted-foreground mt-1">
                  {personName(change.changedBy) ?? "Someone"} ·{" "}
                  <FormattedDate date={change.changedAt} variant="datetime" />
                </p>
                {change.note && <p className="text-xs mt-1.5">{change.note}</p>}
              </div>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
