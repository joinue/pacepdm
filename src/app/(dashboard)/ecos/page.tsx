"use client";

import { useState, useEffect, useCallback } from "react";
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
 * ECOs page — composition root.
 *
 * Owns:
 *   - The list of ECOs
 *   - The currently selected ECO + its items + approval state
 *   - Top-level dialog visibility
 *   - ECO-level mutations (create, transition, delete)
 *
 * Each tab of the detail panel (Details, Items, Approval) is its own
 * component under `./components/`. Types and display constants live in
 * `./types.ts` and `./constants.ts`.
 *
 * The previous version was a single 1100-line file. Keep this page thin —
 * when adding behavior, prefer extracting a new sub-component.
 */
export default function ECOsPage() {
  const { can } = usePermissions();
  const canCreate = can(PERMISSIONS.ECO_CREATE);

  const [ecos, setEcos] = useState<ECO[]>([]);
  const [loading, setLoading] = useState(true);

  // Detail panel
  const [selectedEco, setSelectedEco] = useState<ECO | null>(null);
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

  useEffect(() => {
    void (async () => { await loadEcos(); })();
  }, [loadEcos]);

  // ─── Selection ───────────────────────────────────────────────────────
  function selectEco(eco: ECO) {
    setSelectedEco(eco);
    setDetailTab("details");
    void loadItems(eco.id);
    void loadApproval(eco.id);
  }

  function handleEcoCreated(created: ECO) {
    void loadEcos();
    selectEco(created);
  }

  function handleEcoUpdated(updated: ECO) {
    setSelectedEco(updated);
    setEcos((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
  }

  // ─── ECO-level mutations ─────────────────────────────────────────────
  async function handleTransition(newStatus: string) {
    if (!selectedEco) return;
    setTransitioning(true);
    try {
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
      setSelectedEco(updated);
      loadEcos();
      loadApproval(selectedEco.id);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setTransitioning(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await fetchJson(`/api/ecos/${deleteTarget.id}`, { method: "DELETE" });
      toast.success(`${deleteTarget.ecoNumber} deleted`);
      if (selectedEco?.id === deleteTarget.id) setSelectedEco(null);
      setDeleteTarget(null);
      loadEcos();
    } catch (err) {
      toast.error(errorMessage(err));
      setDeleteTarget(null);
    }
  }

  const transitions = selectedEco ? (VALID_TRANSITIONS[selectedEco.status] || []) : [];
  const canDelete = selectedEco && DELETABLE_STATUSES.includes(selectedEco.status);

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
          selectedEcoId={selectedEco?.id || null}
          onSelect={selectEco}
        />
      </div>

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
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setSelectedEco(null)}>
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
