"use client";

import { useState, useMemo, useCallback } from "react";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { AuditDetails } from "./audit-details";
import {
  History, X, Search, ArrowUpDown, ArrowUp, ArrowDown, Download,
  SlidersHorizontal, Calendar, User, Zap, Box, CalendarRange,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormattedDate } from "@/components/ui/formatted-date";

interface AuditEntry {
  id: string;
  createdAt: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown> | null;
  user: { fullName: string; email: string } | null;
}

type SortField = "createdAt" | "user" | "action" | "entityType";
type SortDir = "asc" | "desc";

// Friendly labels for actions
const actionLabels: Record<string, string> = {
  "file.upload": "File Upload",
  "file.delete": "File Delete",
  "file.checkout": "File Checkout",
  "file.checkin": "File Check-in",
  "file.undo_checkout": "Undo Checkout",
  "file.rename": "File Rename",
  "file.move": "File Move",
  "file.metadata_update": "Metadata Update",
  "file.transition": "State Transition",
  "file.transition.requested": "Transition Requested",
  "file.transition.approved": "Transition Approved",
  "file.bulk_transition": "Bulk Transition",
  "folder.create": "Folder Create",
  "folder.rename": "Folder Rename",
  "folder.delete": "Folder Delete",
  "part.create": "Part Create",
  "part.update": "Part Update",
  "part.delete": "Part Delete",
  "part.vendor_add": "Vendor Added",
  "part.vendor_remove": "Vendor Removed",
  "part.file_link": "File Linked",
  "part.file_unlink": "File Unlinked",
  "bom.create": "BOM Create",
  "bom.update": "BOM Update",
  "bom.delete": "BOM Delete",
  "bom.item.add": "BOM Item Add",
  "bom.item.update": "BOM Item Update",
  "bom.item.delete": "BOM Item Remove",
  "eco.create": "ECO Create",
  "eco.status_change": "ECO Status Change",
  "eco.delete": "ECO Delete",
  "eco.item.added": "ECO Item Added",
  "eco.item.removed": "ECO Item Removed",
  "user.invite": "User Invite",
  "user.activate": "User Activate",
  "user.deactivate": "User Deactivate",
  "role.create": "Role Create",
  "role.update": "Role Update",
  "role.delete": "Role Delete",
  "approval.approved": "Approved",
  "approval.rejected": "Rejected",
  "approval.step.approved": "Step Approved",
  "approval.completed": "Approval Complete",
  "approval_group.create": "Group Create",
  "approval_group.delete": "Group Delete",
  "approval_group.member_add": "Member Added",
  "approval_group.member_remove": "Member Removed",
  "workflow.create": "Workflow Create",
  "workflow.update": "Workflow Update",
  "workflow.delete": "Workflow Delete",
  "workflow_step.create": "Step Added",
  "workflow_step.delete": "Step Removed",
  "workflow_assignment.create": "Assignment Create",
  "workflow_assignment.delete": "Assignment Delete",
  "lifecycle.create": "Lifecycle Create",
  "lifecycle.update": "Lifecycle Update",
  "lifecycle.delete": "Lifecycle Delete",
  "lifecycle_state.create": "State Create",
  "lifecycle_state.update": "State Update",
  "lifecycle_state.delete": "State Delete",
  "lifecycle_transition.create": "Transition Create",
  "lifecycle_transition.delete": "Transition Delete",
  "transition_rule.create": "Rule Create",
  "transition_rule.delete": "Rule Delete",
  "metadata_field.create": "Field Create",
  "metadata_field.delete": "Field Delete",
  "settings.update": "Settings Update",
};

// Action category colors
function getActionVariant(action: string): "info" | "success" | "warning" | "error" | "purple" | "orange" | "muted" {
  if (action.includes("delete") || action.includes("remove") || action.includes("rejected") || action.includes("unlink")) return "error";
  if (action.includes("create") || action.includes("upload") || action.includes("add") || action.includes("invite") || action.includes("link")) return "success";
  if (action.includes("update") || action.includes("rename") || action.includes("move") || action.includes("change")) return "info";
  if (action.includes("approv") || action.includes("completed") || action.includes("activate")) return "purple";
  if (action.includes("checkout") || action.includes("checkin") || action.includes("transition") || action.includes("requested")) return "warning";
  return "muted";
}

// Entity type labels
const entityTypeLabels: Record<string, string> = {
  file: "File",
  folder: "Folder",
  part: "Part",
  bom: "BOM",
  eco: "ECO",
  user: "User",
  role: "Role",
  approval_group: "Approval Group",
  workflow: "Workflow",
  workflow_step: "Workflow Step",
  workflow_assignment: "Workflow Assign",
  lifecycle: "Lifecycle",
  lifecycle_state: "Lifecycle State",
  lifecycle_transition: "Lifecycle Transition",
  transition_rule: "Transition Rule",
  metadata_field: "Metadata Field",
  tenant: "Tenant",
};

export function AuditLogClient({ logs }: { logs: AuditEntry[] }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [entityTypeFilter, setEntityTypeFilter] = useState<string>("all");
  const [userFilter, setUserFilter] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [showFilters, setShowFilters] = useState(false);

  // Extract unique values for filter dropdowns
  const entityTypes = useMemo(
    () => [...new Set(logs.map((l) => l.entityType))].sort(),
    [logs]
  );
  const actions = useMemo(
    () => [...new Set(logs.map((l) => l.action))].sort(),
    [logs]
  );
  const users = useMemo(() => {
    const map = new Map<string, string>();
    for (const l of logs) {
      if (l.user) map.set(l.user.email, l.user.fullName);
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [logs]);

  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    const results = logs.filter((log) => {
      if (entityTypeFilter !== "all" && log.entityType !== entityTypeFilter) return false;
      if (actionFilter !== "all" && log.action !== actionFilter) return false;
      if (userFilter !== "all" && log.user?.email !== userFilter) return false;
      if (dateFrom) {
        const from = new Date(dateFrom);
        from.setHours(0, 0, 0, 0);
        if (new Date(log.createdAt) < from) return false;
      }
      if (dateTo) {
        const to = new Date(dateTo);
        to.setHours(23, 59, 59, 999);
        if (new Date(log.createdAt) > to) return false;
      }
      if (q) {
        const userName = log.user?.fullName?.toLowerCase() ?? "";
        const userEmail = log.user?.email?.toLowerCase() ?? "";
        const detailsStr = log.details ? JSON.stringify(log.details).toLowerCase() : "";
        if (
          !log.action.toLowerCase().includes(q) &&
          !log.entityType.toLowerCase().includes(q) &&
          !log.entityId.toLowerCase().includes(q) &&
          !userName.includes(q) &&
          !userEmail.includes(q) &&
          !detailsStr.includes(q)
        ) {
          return false;
        }
      }
      return true;
    });

    // Sort
    results.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "createdAt":
          cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          break;
        case "user":
          cmp = (a.user?.fullName ?? "").localeCompare(b.user?.fullName ?? "");
          break;
        case "action":
          cmp = a.action.localeCompare(b.action);
          break;
        case "entityType":
          cmp = a.entityType.localeCompare(b.entityType);
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

    return results;
  }, [logs, searchQuery, entityTypeFilter, actionFilter, userFilter, dateFrom, dateTo, sortField, sortDir]);

  const activeFilterCount =
    (entityTypeFilter !== "all" ? 1 : 0) +
    (actionFilter !== "all" ? 1 : 0) +
    (userFilter !== "all" ? 1 : 0) +
    (dateFrom ? 1 : 0) +
    (dateTo ? 1 : 0);

  const hasFilters = activeFilterCount > 0 || searchQuery;

  function clearFilters() {
    setSearchQuery("");
    setActionFilter("all");
    setEntityTypeFilter("all");
    setUserFilter("all");
    setDateFrom("");
    setDateTo("");
  }

  const toggleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "createdAt" ? "desc" : "asc");
    }
  }, [sortField]);

  function SortIcon({ field }: { field: SortField }) {
    if (sortField !== field) return <ArrowUpDown className="w-3 h-3 ml-1 opacity-40" />;
    return sortDir === "asc"
      ? <ArrowUp className="w-3 h-3 ml-1" />
      : <ArrowDown className="w-3 h-3 ml-1" />;
  }

  function exportCsv() {
    const escCsv = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const header = ["Timestamp", "User", "Email", "Action", "Entity Type", "Entity ID", "Details"];
    const rows = filtered.map((log) => [
      new Date(log.createdAt).toISOString(),
      log.user?.fullName ?? "System",
      log.user?.email ?? "",
      log.action,
      log.entityType,
      log.entityId,
      log.details ? JSON.stringify(log.details) : "",
    ]);
    const csv = [header, ...rows].map((r) => r.map(escCsv).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      {/* Search + filter bar */}
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          {/* Search */}
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search actions, users, entities, details..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 pr-8"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Filter toggle */}
          <Button
            variant={showFilters || activeFilterCount > 0 ? "default" : "outline"}
            size="sm"
            className="h-8 gap-1.5 shrink-0"
            onClick={() => setShowFilters(!showFilters)}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Filters</span>
            {activeFilterCount > 0 && (
              <span className="ml-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary-foreground/20 text-[10px] font-bold">
                {activeFilterCount}
              </span>
            )}
          </Button>

          {/* Export */}
          <Button variant="outline" size="sm" onClick={exportCsv} className="h-8 gap-1.5 shrink-0" disabled={filtered.length === 0}>
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">CSV</span>
          </Button>
        </div>

        {/* Expandable filter panel */}
        {showFilters && (
          <div className="flex flex-wrap items-end gap-3 p-3 rounded-lg border bg-muted/30 animate-in fade-in-0 slide-in-from-top-1 duration-200">
            <FilterSelect
              icon={<Zap className="w-3.5 h-3.5" />}
              label="Action"
              value={actionFilter}
              onChange={setActionFilter}
              options={actions.map((a) => ({ value: a, label: actionLabels[a] || a }))}
              allLabel="All actions"
            />
            <FilterSelect
              icon={<Box className="w-3.5 h-3.5" />}
              label="Entity"
              value={entityTypeFilter}
              onChange={setEntityTypeFilter}
              options={entityTypes.map((t) => ({ value: t, label: entityTypeLabels[t] || t }))}
              allLabel="All entities"
            />
            <FilterSelect
              icon={<User className="w-3.5 h-3.5" />}
              label="User"
              value={userFilter}
              onChange={setUserFilter}
              options={users.map(([email, name]) => ({ value: email, label: name }))}
              allLabel="All users"
            />
            <div className="flex items-end gap-2">
              <div className="space-y-1">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                  <CalendarRange className="w-3 h-3" />From
                </span>
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="h-7 w-[130px] text-xs"
                />
              </div>
              <div className="space-y-1">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                  <Calendar className="w-3 h-3" />To
                </span>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="h-7 w-[130px] text-xs"
                />
              </div>
            </div>
            {activeFilterCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground"
                onClick={clearFilters}
              >
                <X className="w-3 h-3 mr-1" />
                Clear all
              </Button>
            )}
          </div>
        )}

        {/* Active filter chips */}
        {activeFilterCount > 0 && !showFilters && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">Filters:</span>
            {actionFilter !== "all" && (
              <FilterChip
                label={actionLabels[actionFilter] || actionFilter}
                onRemove={() => setActionFilter("all")}
              />
            )}
            {entityTypeFilter !== "all" && (
              <FilterChip
                label={entityTypeLabels[entityTypeFilter] || entityTypeFilter}
                onRemove={() => setEntityTypeFilter("all")}
              />
            )}
            {userFilter !== "all" && (
              <FilterChip
                label={users.find(([e]) => e === userFilter)?.[1] || userFilter}
                onRemove={() => setUserFilter("all")}
              />
            )}
            {dateFrom && (
              <FilterChip label={`From ${dateFrom}`} onRemove={() => setDateFrom("")} />
            )}
            {dateTo && (
              <FilterChip label={`To ${dateTo}`} onRemove={() => setDateTo("")} />
            )}
            <button
              onClick={clearFilters}
              className="text-[10px] text-muted-foreground hover:text-foreground ml-1 cursor-pointer"
            >
              Clear all
            </button>
          </div>
        )}

        {/* Results count */}
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {hasFilters ? (
              <>
                <span className="font-medium text-foreground">{filtered.length}</span> of {logs.length} entries
              </>
            ) : (
              <>{logs.length} entries</>
            )}
          </p>
        </div>
      </div>

      {/* Table */}
      <div className="border rounded-lg bg-background overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <button className="flex items-center hover:text-foreground cursor-pointer" onClick={() => toggleSort("createdAt")}>
                  Timestamp<SortIcon field="createdAt" />
                </button>
              </TableHead>
              <TableHead>
                <button className="flex items-center hover:text-foreground cursor-pointer" onClick={() => toggleSort("user")}>
                  User<SortIcon field="user" />
                </button>
              </TableHead>
              <TableHead>
                <button className="flex items-center hover:text-foreground cursor-pointer" onClick={() => toggleSort("action")}>
                  Action<SortIcon field="action" />
                </button>
              </TableHead>
              <TableHead>
                <button className="flex items-center hover:text-foreground cursor-pointer" onClick={() => toggleSort("entityType")}>
                  Entity<SortIcon field="entityType" />
                </button>
              </TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-16">
                  <History className="w-10 h-10 mx-auto mb-3 text-muted-foreground/20" />
                  <p className="text-sm font-medium text-muted-foreground">
                    {hasFilters ? "No entries match your filters" : "No activity recorded yet"}
                  </p>
                  {hasFilters && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3 text-xs"
                      onClick={clearFilters}
                    >
                      Clear all filters
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((log) => (
                <TableRow key={log.id} className="group">
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    <FormattedDate date={log.createdAt} />
                  </TableCell>
                  <TableCell>
                    <span className="text-sm">{log.user?.fullName ?? <span className="text-muted-foreground italic">System</span>}</span>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={getActionVariant(log.action)}
                      className="text-[10px] px-1.5 py-0 font-medium"
                    >
                      {actionLabels[log.action] || log.action}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-muted-foreground">
                      {entityTypeLabels[log.entityType] || log.entityType}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground max-w-xs">
                    {log.details ? <AuditDetails details={log.details} /> : <span className="text-muted-foreground/40">--</span>}
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

// --- Filter Select ---

function FilterSelect({
  icon,
  label,
  value,
  onChange,
  options,
  allLabel,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  allLabel: string;
}) {
  return (
    <div className="space-y-1">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1">
        {icon}{label}
      </span>
      <Select value={value} onValueChange={(v) => onChange(v ?? "all")}>
        <SelectTrigger className="h-7 w-[160px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{allLabel}</SelectItem>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// --- Filter Chip ---

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-full border border-border/60 bg-muted/50 text-xs text-foreground">
      {label}
      <button
        onClick={onRemove}
        className="inline-flex items-center justify-center h-4 w-4 rounded-full hover:bg-foreground/10 transition-colors cursor-pointer"
      >
        <X className="w-2.5 h-2.5" />
      </button>
    </span>
  );
}
