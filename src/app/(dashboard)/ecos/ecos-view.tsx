"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FormattedDate } from "@/components/ui/formatted-date";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Plus, Loader2, X, ArrowRight, Trash2,
} from "lucide-react";
import { fetchJson, errorMessage } from "@/lib/api-client";
import { usePermissions } from "@/hooks/use-permissions";
import { useRealtimeTable } from "@/hooks/use-realtime-table";
import { useTenantUser } from "@/components/providers/tenant-provider";
import { PERMISSIONS } from "@/lib/permissions";

import type { ECO, ECOItem, ApprovalData } from "./types";
import {
  statusVariants, priorityVariants, VALID_TRANSITIONS, DELETABLE_STATUSES,
  approvalStatusConfig,
} from "./constants";
import { CreateEcoDialog } from "./components/create-eco-dialog";
import { AddEcoItemDialog } from "./components/add-eco-item-dialog";
import { EcoList } from "./components/eco-list";
import { EcoDetailsTab } from "./components/eco-details-tab";
import { EcoItemsTab } from "./components/eco-items-tab";
import { EcoApprovalTab } from "./components/eco-approval-tab";

/**
 * ECOs view — list + optional detail. Selection lives in the URL path
 * (/ecos/[ecoId]), not in local state, so every ECO has a shareable,
 * bookmarkable URL and browser back/forward works.
 *
 * Rendered by both:
 *   /ecos              → no selection (shows the list)
 *   /ecos/[ecoId]      → detail for one ECO alongside the list
 *
 * The selected ECO object is derived from the list (which includes
 * createdBy — see `/api/ecos` GET), so mutations only need to refresh
 * the list and the detail panel updates automatically.
 */
export function EcosView({ selectedEcoId }: { selectedEcoId: string | null }) {
  const router = useRouter();
  const { can } = usePermissions();
  const canCreate = can(PERMISSIONS.ECO_CREATE);
  const user = useTenantUser();

  const [ecos, setEcos] = useState<ECO[]>([]);
  const [loading, setLoading] = useState(true);

  // Detail panel state — items and approval still need their own fetches
  // since they're large and only relevant when a detail is open.
  const [detailTab, setDetailTab] = useState("details");
  const [items, setItems] = useState<ECOItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [approval, setApproval] = useState<ApprovalData | null>(null);
  const [loadingApproval, setLoadingApproval] = useState(false);
  const [transitioning, setTransitioning] = useState(false);

  // Dialogs
  const [showCreate, setShowCreate] = useState(false);
  const [showAddItem, setShowAddItem] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ECO | null>(null);
  // Soft-warning gate: when the user requests a "world-changing" transition
  // (submit, implement) on an ECO that has zero affected items, we hold the
  // intended next status here and prompt "really?" before calling the API.
  const [pendingEmptyTransition, setPendingEmptyTransition] = useState<string | null>(null);

  // ─── Loaders ─────────────────────────────────────────────────────────
  const loadEcos = useCallback(async () => {
    try {
      const data = await fetchJson<ECO[]>("/api/ecos");
      setEcos(Array.isArray(data) ? data : []);
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to load ECOs");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadItems = useCallback(async (ecoId: string) => {
    setLoadingItems(true);
    try {
      const data = await fetchJson<ECOItem[]>(`/api/ecos/${ecoId}/items`);
      setItems(Array.isArray(data) ? data : []);
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to load items");
    } finally {
      setLoadingItems(false);
    }
  }, []);

  const loadApproval = useCallback(async (ecoId: string) => {
    setLoadingApproval(true);
    try {
      const data = await fetchJson<ApprovalData | null>(`/api/ecos/${ecoId}/approval`);
      setApproval(data);
    } catch {
      // Approval may legitimately not exist (404) — show the empty state
      setApproval(null);
    } finally {
      setLoadingApproval(false);
    }
  }, []);

  // ─── Effects ─────────────────────────────────────────────────────────
  useEffect(() => {
    void (async () => { await loadEcos(); })();
  }, [loadEcos]);

  // Whenever the URL-selected ECO changes, reload its items + approval.
  // Reset the detail tab so we always land on "details" when navigating
  // between ECOs — feels less jarring than landing mid-tab.
  useEffect(() => {
    if (!selectedEcoId) {
      setItems([]);
      setApproval(null);
      return;
    }
    setDetailTab("details");
    void loadItems(selectedEcoId);
    void loadApproval(selectedEcoId);
  }, [selectedEcoId, loadItems, loadApproval]);

  // ─── Realtime ────────────────────────────────────────────────────────
  //
  // Three channels, all scoped to this tenant:
  //   - `ecos`: status transitions (DRAFT → SUBMITTED → APPROVED → …)
  //     refresh the list so badges flip without a reload.
  //   - `eco_items`: when the open ECO has an item added, removed, or
  //     its revision rewritten by `implement_eco`, reload its items.
  //   - `approval_decisions`: when an approver clicks on another tab
  //     (or the workflow engine inserts a decision row), reload the
  //     approval tab of the currently-open ECO.
  //
  // The notification provider already subscribes to `notifications`
  // and `approval_decisions` globally for the bell, but that only
  // refreshes the count — the ECO detail panel needs its own refetch
  // to rerender the decisions list.
  useRealtimeTable({
    table: "ecos",
    filter: `tenantId=eq.${user.tenantId}`,
    onChange: loadEcos,
  });
  useRealtimeTable({
    table: "eco_items",
    // eco_items has no tenantId column — it's scoped via its parent
    // ecos row. We still fire a refresh on every change and let the
    // detail-load below no-op when nothing is selected. Cheap.
    onChange: () => {
      if (selectedEcoId) void loadItems(selectedEcoId);
    },
    enabled: !!selectedEcoId,
  });
  useRealtimeTable({
    table: "approval_decisions",
    onChange: () => {
      if (selectedEcoId) void loadApproval(selectedEcoId);
    },
    enabled: !!selectedEcoId,
  });

  // ─── Navigation ──────────────────────────────────────────────────────
  // Accepts the whole ECO because that's what EcoList passes to onSelect;
  // we only need the id, but keeping the signature matches the component.
  const selectEco = useCallback((eco: ECO) => {
    router.push(`/ecos/${eco.id}`);
  }, [router]);

  const clearSelection = useCallback(() => {
    router.push("/ecos");
  }, [router]);

  // ─── Derived state ───────────────────────────────────────────────────
  const selectedEco = ecos.find((e) => e.id === selectedEcoId) || null;
  const selectionMissing = !loading && selectedEcoId !== null && !selectedEco;
  const transitions = selectedEco ? (VALID_TRANSITIONS[selectedEco.status] || []) : [];
  const canDelete = selectedEco && DELETABLE_STATUSES.includes(selectedEco.status);

  // ─── ECO-level mutations ─────────────────────────────────────────────
  function handleEcoCreated(created: ECO) {
    loadEcos();
    router.push(`/ecos/${created.id}`);
  }

  // Transitions that we warn about when the ECO has no affected items.
  // SUBMITTED starts an approval workflow — embarrassing if it's empty.
  // IMPLEMENTED is the one that actually changes files/parts in the vault,
  // so an empty implement is a no-op release and almost always a mistake.
  const EMPTY_WARN_STATUSES = new Set(["SUBMITTED", "IMPLEMENTED"]);

  function handleTransition(newStatus: string) {
    if (!selectedEco) return;
    if (EMPTY_WARN_STATUSES.has(newStatus) && items.length === 0) {
      setPendingEmptyTransition(newStatus);
      return;
    }
    void performTransition(newStatus);
  }

  async function performTransition(newStatus: string) {
    if (!selectedEco) return;
    setTransitioning(true);
    try {
      // The APPROVED → IMPLEMENTED transition is special: it's the moment
      // the ECO actually changes the world (files transition WIP→Released
      // and get stamped with the ECO id). That work runs atomically inside
      // the implement_eco Postgres function (see migration-011), so we
      // route through the dedicated endpoint instead of the generic PUT.
      if (selectedEco.status === "APPROVED" && newStatus === "IMPLEMENTED") {
        const result = await fetchJson<{
          partsReleased?: number;
          filesTransitioned: number;
          filesStamped: number;
        }>(`/api/ecos/${selectedEco.id}/implement`, { method: "POST" });
        const parts = result.partsReleased ?? 0;
        const files = result.filesTransitioned;
        const bits: string[] = [];
        if (parts > 0) bits.push(`${parts} part${parts !== 1 ? "s" : ""} released`);
        if (files > 0) bits.push(`${files} file${files !== 1 ? "s" : ""} released`);
        toast.success(
          bits.length > 0
            ? `ECO implemented — ${bits.join(", ")}`
            : "ECO implemented"
        );
        // Refresh the list so the derived selectedEco picks up the new status
        await loadEcos();
        return;
      }

      const updated = await fetchJson<ECO & { pendingApproval?: boolean }>(`/api/ecos/${selectedEco.id}`, {
        method: "PUT",
        body: { status: newStatus },
      });
      if (updated.pendingApproval) {
        toast.success("Submitted for approval — workflow started");
        setDetailTab("approval");
      } else {
        toast.success(`Status changed to ${newStatus.replace("_", " ")}`);
      }
      await loadEcos();
      void loadApproval(selectedEco.id);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setTransitioning(false);
    }
  }

  // Callback for EcoDetailsTab's inline edit. The tab passes the updated
  // ECO, but we ignore it and refresh the list so the derived selectedEco
  // is always pulled from a single source of truth.
  function handleEcoUpdated(_updated: ECO) {
    void _updated;
    loadEcos();
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await fetchJson(`/api/ecos/${deleteTarget.id}`, { method: "DELETE" });
      toast.success(`${deleteTarget.ecoNumber} deleted`);
      // If we deleted the currently-viewed ECO, navigate back to the list.
      if (selectedEcoId === deleteTarget.id) {
        clearSelection();
      }
      setDeleteTarget(null);
      loadEcos();
    } catch (err) {
      toast.error(errorMessage(err));
      setDeleteTarget(null);
    }
  }

  return (
    <div className="flex h-full gap-0">
      {/* Left: ECO List */}
      <div className={`flex-1 min-w-0 space-y-4 ${selectedEco ? "hidden lg:block lg:max-w-md xl:max-w-lg" : ""}`}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">Engineering Change Orders</h2>
            <p className="text-sm text-muted-foreground mt-1">Track and manage engineering changes</p>
          </div>
          {canCreate && (
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="w-4 h-4 mr-2" />New ECO
            </Button>
          )}
        </div>

        <EcoList
          ecos={ecos}
          loading={loading}
          selectedEcoId={selectedEcoId}
          onSelect={selectEco}
        />
      </div>

      {/* Right: Missing-selection empty state */}
      {selectionMissing && (
        <div className="flex-1 min-w-0 lg:border-l lg:pl-6 lg:ml-6">
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center py-12">
            <p className="text-muted-foreground">This ECO no longer exists.</p>
            <Button variant="outline" size="sm" onClick={clearSelection}>
              Back to ECO list
            </Button>
          </div>
        </div>
      )}

      {/* Right: Detail Panel */}
      {selectedEco && (
        <div className="flex-1 min-w-0 lg:border-l lg:pl-6 lg:ml-6">
          {/* Header */}
          <div className="flex items-start justify-between gap-3 mb-5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                <span className="text-xs font-mono text-muted-foreground font-medium">{selectedEco.ecoNumber}</span>
                <Badge variant={statusVariants[selectedEco.status] || "muted"}>
                  {selectedEco.status.replace("_", " ")}
                </Badge>
                <Badge variant={priorityVariants[selectedEco.priority] || "muted"}>
                  {selectedEco.priority}
                </Badge>
              </div>
              <h3 className="text-lg font-semibold leading-snug">{selectedEco.title}</h3>
              {selectedEco.createdBy && (
                <p className="text-xs text-muted-foreground mt-1">
                  Created by {selectedEco.createdBy.fullName} on{" "}
                  <FormattedDate date={selectedEco.createdAt} variant="date" />
                </p>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {canDelete && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                  onClick={() => setDeleteTarget(selectedEco)}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              )}
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={clearSelection}>
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>

          {/* Status transition buttons */}
          {transitions.length > 0 && (
            <div className="flex gap-2 mb-5 flex-wrap">
              {transitions.map((t) => (
                <Button
                  key={t.status}
                  size="sm"
                  variant={t.variant || "outline"}
                  disabled={transitioning}
                  onClick={() => handleTransition(t.status)}
                >
                  {transitioning
                    ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    : <ArrowRight className="w-3.5 h-3.5 mr-1.5" />
                  }
                  {t.label}
                </Button>
              ))}
            </div>
          )}

          {/* Tabs */}
          <Tabs value={detailTab} onValueChange={setDetailTab}>
            <TabsList>
              <TabsTrigger value="details">Details</TabsTrigger>
              <TabsTrigger value="items">
                Affected Items
                {items.length > 0 && (
                  <Badge variant="secondary" className="text-[9px] ml-1.5 px-1.5 py-0">{items.length}</Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="approval">
                Approval
                {approval && (
                  <Badge
                    variant={approvalStatusConfig[approval.status]?.variant || "muted"}
                    className="text-[9px] ml-1.5 px-1.5 py-0"
                  >
                    {approvalStatusConfig[approval.status]?.label}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="details" className="mt-4">
              <EcoDetailsTab eco={selectedEco} onUpdated={handleEcoUpdated} />
            </TabsContent>

            <TabsContent value="items" className="mt-4">
              <EcoItemsTab
                ecoId={selectedEco.id}
                ecoStatus={selectedEco.status}
                items={items}
                loading={loadingItems}
                onAddClick={() => setShowAddItem(true)}
                onItemRemoved={() => loadItems(selectedEco.id)}
              />
            </TabsContent>

            <TabsContent value="approval" className="mt-4">
              <EcoApprovalTab approval={approval} loading={loadingApproval} />
            </TabsContent>
          </Tabs>
        </div>
      )}

      {/* Dialogs */}
      <CreateEcoDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={handleEcoCreated}
      />
      {selectedEco && (
        <AddEcoItemDialog
          open={showAddItem}
          onOpenChange={setShowAddItem}
          ecoId={selectedEco.id}
          onAdded={() => loadItems(selectedEco.id)}
        />
      )}

      <AlertDialog
        open={!!pendingEmptyTransition}
        onOpenChange={(open) => !open && setPendingEmptyTransition(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingEmptyTransition === "IMPLEMENTED" ? "Implement empty ECO?" : "Submit empty ECO?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This ECO has no affected parts or files.{" "}
              {pendingEmptyTransition === "IMPLEMENTED"
                ? "Implementing it will mark the ECO as released but will not change any parts or files in the vault. This is usually a mistake — you probably want to go back and add the items it covers first."
                : "Submitting it will start an approval workflow with nothing attached. Reviewers will have no items to assess. Continue anyway?"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Go back and add items</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const next = pendingEmptyTransition;
                setPendingEmptyTransition(null);
                if (next) void performTransition(next);
              }}
            >
              Continue anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.ecoNumber}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &ldquo;{deleteTarget?.title}&rdquo; and all its affected items. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete ECO
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
