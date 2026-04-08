"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FormattedDate } from "@/components/ui/formatted-date";
import {
  Plus, Loader2, ClipboardList, X, ArrowRight, Trash2, FileText,
  CheckCircle, XCircle, Clock, Shield, MessageSquare, Search, Pencil,
} from "lucide-react";
import { toast } from "sonner";

// --- Types ---

interface ECO {
  id: string;
  ecoNumber: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  reason: string | null;
  changeType: string | null;
  costImpact: string | null;
  disposition: string | null;
  effectivity: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy?: { fullName: string; email: string };
}

interface ECOItem {
  id: string;
  ecoId: string;
  fileId: string;
  changeType: string;
  reason: string | null;
  file: { id: string; name: string; partNumber: string | null; lifecycleState: string; currentVersion: number };
}

interface ApprovalData {
  id: string;
  title: string;
  status: string;
  currentStepOrder: number;
  createdAt: string;
  completedAt: string | null;
  requestedBy: { fullName: string; email: string };
  workflow: { name: string } | null;
  decisions: {
    id: string;
    status: string;
    signatureLabel: string | null;
    approvalMode: string | null;
    comment: string | null;
    decidedAt: string | null;
    deadlineAt: string | null;
    group: { name: string };
    decider: { fullName: string } | null;
    step: { stepOrder: number; signatureLabel: string } | null;
  }[];
  timeline: { id: string; event: string; details: string | null; createdAt: string; user: { fullName: string } | null }[];
}

interface SearchFile {
  id: string;
  name: string;
  partNumber: string | null;
  lifecycleState: string;
}

// --- Constants ---

const statusVariants: Record<string, "muted" | "info" | "warning" | "success" | "error" | "purple"> = {
  DRAFT: "muted",
  SUBMITTED: "info",
  IN_REVIEW: "warning",
  APPROVED: "success",
  REJECTED: "error",
  IMPLEMENTED: "purple",
  CLOSED: "muted",
};

const priorityVariants: Record<string, "muted" | "info" | "orange" | "error"> = {
  LOW: "muted",
  MEDIUM: "info",
  HIGH: "orange",
  CRITICAL: "error",
};

const changeTypeLabels: Record<string, { label: string; variant: "info" | "warning" | "error" }> = {
  ADD: { label: "Add", variant: "info" },
  MODIFY: { label: "Modify", variant: "warning" },
  REMOVE: { label: "Remove", variant: "error" },
};

const VALID_TRANSITIONS: Record<string, { status: string; label: string; variant?: "default" | "success" | "destructive" }[]> = {
  DRAFT: [{ status: "SUBMITTED", label: "Submit for Review", variant: "default" }],
  SUBMITTED: [
    { status: "IN_REVIEW", label: "Begin Review", variant: "default" },
    { status: "REJECTED", label: "Reject", variant: "destructive" },
  ],
  IN_REVIEW: [
    { status: "APPROVED", label: "Approve", variant: "success" },
    { status: "REJECTED", label: "Reject", variant: "destructive" },
  ],
  APPROVED: [{ status: "IMPLEMENTED", label: "Mark Implemented", variant: "success" }],
  REJECTED: [{ status: "DRAFT", label: "Reopen as Draft" }],
  IMPLEMENTED: [{ status: "CLOSED", label: "Close", variant: "default" }],
  CLOSED: [],
};

const reasonLabels: Record<string, string> = {
  DESIGN_IMPROVEMENT: "Design Improvement",
  COST_REDUCTION: "Cost Reduction",
  DEFECT_FIX: "Defect / Failure Fix",
  REGULATORY: "Regulatory / Compliance",
  MANUFACTURING: "Manufacturing Improvement",
  CUSTOMER_REQUEST: "Customer Request",
  OTHER: "Other",
};

const changeTypeLabelsEco: Record<string, string> = {
  DOCUMENT_ONLY: "Document Only",
  COMPONENT: "Component",
  ASSEMBLY: "Assembly",
  PROCESS: "Process",
};

const costImpactLabels: Record<string, string> = {
  NONE: "None",
  MINOR: "Minor",
  MODERATE: "Moderate",
  SIGNIFICANT: "Significant",
};

const dispositionLabels: Record<string, string> = {
  USE_AS_IS: "Use As-Is",
  REWORK: "Rework",
  SCRAP: "Scrap",
  RETURN_TO_VENDOR: "Return to Vendor",
  NOT_APPLICABLE: "N/A",
};

const DELETABLE_STATUSES = ["DRAFT", "REJECTED", "CLOSED"];

const approvalStatusConfig: Record<string, { label: string; variant: "muted" | "warning" | "success" | "error" | "purple" }> = {
  PENDING: { label: "Pending", variant: "warning" },
  APPROVED: { label: "Approved", variant: "success" },
  REJECTED: { label: "Rejected", variant: "error" },
  RECALLED: { label: "Recalled", variant: "muted" },
  REWORK: { label: "Rework", variant: "purple" },
  WAITING: { label: "Waiting", variant: "muted" },
};

const modeLabels: Record<string, string> = {
  ANY: "Any one member",
  ALL: "All members",
  MAJORITY: "Majority",
};

// --- Component ---

export default function ECOsPage() {
  const [ecos, setEcos] = useState<ECO[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newPriority, setNewPriority] = useState("MEDIUM");
  const [newReason, setNewReason] = useState("");
  const [newChangeType, setNewChangeType] = useState("");
  const [creating, setCreating] = useState(false);

  // Detail panel
  const [selectedEco, setSelectedEco] = useState<ECO | null>(null);
  const [detailTab, setDetailTab] = useState("details");

  // ECO items
  const [items, setItems] = useState<ECOItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [showAddItem, setShowAddItem] = useState(false);
  const [fileSearch, setFileSearch] = useState("");
  const [fileResults, setFileResults] = useState<SearchFile[]>([]);
  const [searchingFiles, setSearchingFiles] = useState(false);
  const [selectedFile, setSelectedFile] = useState<SearchFile | null>(null);
  const [itemChangeType, setItemChangeType] = useState("MODIFY");
  const [itemReason, setItemReason] = useState("");

  // Approval
  const [approval, setApproval] = useState<ApprovalData | null>(null);
  const [loadingApproval, setLoadingApproval] = useState(false);

  // Edit fields
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editPriority, setEditPriority] = useState("");
  const [editReason, setEditReason] = useState("");
  const [editChangeType, setEditChangeType] = useState("");
  const [editCostImpact, setEditCostImpact] = useState("");
  const [editDisposition, setEditDisposition] = useState("");
  const [editEffectivity, setEditEffectivity] = useState("");
  const [saving, setSaving] = useState(false);

  // Status change
  const [transitioning, setTransitioning] = useState(false);

  // Delete
  const [deleteTarget, setDeleteTarget] = useState<ECO | null>(null);

  const loadEcos = useCallback(async () => {
    const res = await fetch("/api/ecos");
    const data = await res.json();
    setEcos(Array.isArray(data) ? data : []);
    setLoading(false);
  }, []);

  useEffect(() => { loadEcos(); }, [loadEcos]);

  async function loadItems(ecoId: string) {
    setLoadingItems(true);
    const res = await fetch(`/api/ecos/${ecoId}/items`);
    const data = await res.json();
    setItems(Array.isArray(data) ? data : []);
    setLoadingItems(false);
  }

  async function loadApproval(ecoId: string) {
    setLoadingApproval(true);
    const res = await fetch(`/api/ecos/${ecoId}/approval`);
    const data = await res.json();
    setApproval(data);
    setLoadingApproval(false);
  }

  function selectEco(eco: ECO) {
    setSelectedEco(eco);
    setDetailTab("details");
    setEditing(false);
    loadItems(eco.id);
    loadApproval(eco.id);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    const res = await fetch("/api/ecos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: newTitle, description: newDescription, priority: newPriority, reason: newReason || null, changeType: newChangeType || null }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); setCreating(false); return; }
    const created = await res.json();
    toast.success("ECO created");
    setShowCreate(false);
    setNewTitle(""); setNewDescription(""); setNewPriority("MEDIUM"); setNewReason(""); setNewChangeType(""); setCreating(false);
    await loadEcos();
    selectEco(created);
  }

  async function handleTransition(newStatus: string) {
    if (!selectedEco) return;
    setTransitioning(true);
    const res = await fetch(`/api/ecos/${selectedEco.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); setTransitioning(false); return; }
    const updated = await res.json();
    if (updated.pendingApproval) {
      toast.success("Submitted for approval — workflow started");
      setDetailTab("approval");
    } else {
      toast.success(`Status changed to ${newStatus.replace("_", " ")}`);
    }
    setSelectedEco(updated);
    setTransitioning(false);
    loadEcos();
    loadApproval(selectedEco.id);
  }

  async function handleSaveFields() {
    if (!selectedEco) return;
    setSaving(true);
    const res = await fetch(`/api/ecos/${selectedEco.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: editTitle, description: editDescription, priority: editPriority, reason: editReason || null, changeType: editChangeType || null, costImpact: editCostImpact || null, disposition: editDisposition || null, effectivity: editEffectivity || null }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); setSaving(false); return; }
    const updated = await res.json();
    setSelectedEco(updated);
    setEditing(false);
    setSaving(false);
    toast.success("ECO updated");
    loadEcos();
  }

  function startEditing() {
    if (!selectedEco) return;
    setEditTitle(selectedEco.title);
    setEditDescription(selectedEco.description || "");
    setEditPriority(selectedEco.priority);
    setEditReason(selectedEco.reason || "");
    setEditChangeType(selectedEco.changeType || "");
    setEditCostImpact(selectedEco.costImpact || "");
    setEditDisposition(selectedEco.disposition || "");
    setEditEffectivity(selectedEco.effectivity || "");
    setEditing(true);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    const res = await fetch(`/api/ecos/${deleteTarget.id}`, { method: "DELETE" });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); setDeleteTarget(null); return; }
    toast.success(`${deleteTarget.ecoNumber} deleted`);
    if (selectedEco?.id === deleteTarget.id) setSelectedEco(null);
    setDeleteTarget(null);
    loadEcos();
  }

  // File search for adding items
  async function searchFiles(q: string) {
    setFileSearch(q);
    if (q.length < 2) { setFileResults([]); return; }
    setSearchingFiles(true);
    const res = await fetch(`/api/files?q=${encodeURIComponent(q)}&limit=10`);
    const data = await res.json();
    setFileResults(Array.isArray(data) ? data : data.files || []);
    setSearchingFiles(false);
  }

  async function handleAddItem(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedEco || !selectedFile) return;
    const res = await fetch(`/api/ecos/${selectedEco.id}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId: selectedFile.id, changeType: itemChangeType, reason: itemReason }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success("Item added");
    setShowAddItem(false);
    setSelectedFile(null); setFileSearch(""); setFileResults([]); setItemChangeType("MODIFY"); setItemReason("");
    loadItems(selectedEco.id);
  }

  async function handleRemoveItem(itemId: string) {
    if (!selectedEco) return;
    const res = await fetch(`/api/ecos/${selectedEco.id}/items`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success("Item removed");
    loadItems(selectedEco.id);
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
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="w-4 h-4 mr-2" />New ECO
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : ecos.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <ClipboardList className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No ECOs yet</p>
            <p className="text-sm mt-1">Create one to start tracking engineering changes.</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {ecos.map((eco) => (
              <div
                key={eco.id}
                onClick={() => selectEco(eco)}
                className={`border rounded-lg p-3.5 cursor-pointer transition-all ${
                  selectedEco?.id === eco.id
                    ? "border-primary bg-primary/5 shadow-sm"
                    : "bg-background hover:border-foreground/20 hover:shadow-sm"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[11px] font-mono text-muted-foreground">{eco.ecoNumber}</span>
                      <Badge variant={statusVariants[eco.status] || "muted"} className="text-[10px]">
                        {eco.status.replace("_", " ")}
                      </Badge>
                    </div>
                    <p className="font-medium text-sm leading-snug">{eco.title}</p>
                    {eco.description && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{eco.description}</p>
                    )}
                  </div>
                  <Badge variant={priorityVariants[eco.priority] || "muted"} className="text-[10px] shrink-0">
                    {eco.priority}
                  </Badge>
                </div>
                <p className="text-[10px] text-muted-foreground/60 mt-2">
                  <FormattedDate date={eco.createdAt} variant="date" />
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Right: Detail Panel */}
      {selectedEco && (
        <div className="flex-1 min-w-0 lg:border-l lg:pl-6 lg:ml-6">
          {/* Detail Header */}
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
                  Created by {selectedEco.createdBy.fullName} on <FormattedDate date={selectedEco.createdAt} variant="date" />
                </p>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {canDelete && (
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive hover:text-destructive" onClick={() => setDeleteTarget(selectedEco)}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              )}
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setSelectedEco(null)}>
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>

          {/* Status Actions */}
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

            {/* --- Details Tab --- */}
            <TabsContent value="details" className="mt-4">
              <ScrollArea className="h-[calc(100vh-22rem)]">
                {editing ? (
                  <div className="space-y-4 pr-1">
                    <div className="space-y-2">
                      <Label>Title</Label>
                      <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label>Description</Label>
                      <Textarea value={editDescription} onChange={(e) => setEditDescription(e.target.value)} rows={4} placeholder="Describe the change and reason..." />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Priority</Label>
                        <Select value={editPriority} onValueChange={(v) => setEditPriority(v ?? editPriority)}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="LOW">Low</SelectItem>
                            <SelectItem value="MEDIUM">Medium</SelectItem>
                            <SelectItem value="HIGH">High</SelectItem>
                            <SelectItem value="CRITICAL">Critical</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>Reason for Change</Label>
                        <Select value={editReason} onValueChange={(v) => setEditReason(v ?? "")}>
                          <SelectTrigger><SelectValue placeholder="Select reason..." /></SelectTrigger>
                          <SelectContent>
                            {Object.entries(reasonLabels).map(([k, v]) => (
                              <SelectItem key={k} value={k}>{v}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Change Type</Label>
                        <Select value={editChangeType} onValueChange={(v) => setEditChangeType(v ?? "")}>
                          <SelectTrigger><SelectValue placeholder="Select type..." /></SelectTrigger>
                          <SelectContent>
                            {Object.entries(changeTypeLabelsEco).map(([k, v]) => (
                              <SelectItem key={k} value={k}>{v}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>Cost Impact</Label>
                        <Select value={editCostImpact} onValueChange={(v) => setEditCostImpact(v ?? "")}>
                          <SelectTrigger><SelectValue placeholder="Select impact..." /></SelectTrigger>
                          <SelectContent>
                            {Object.entries(costImpactLabels).map(([k, v]) => (
                              <SelectItem key={k} value={k}>{v}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Disposition</Label>
                        <Select value={editDisposition} onValueChange={(v) => setEditDisposition(v ?? "")}>
                          <SelectTrigger><SelectValue placeholder="Select disposition..." /></SelectTrigger>
                          <SelectContent>
                            {Object.entries(dispositionLabels).map(([k, v]) => (
                              <SelectItem key={k} value={k}>{v}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>Effectivity</Label>
                        <Input value={editEffectivity} onChange={(e) => setEditEffectivity(e.target.value)} placeholder="e.g., Immediate, Next lot, SN 500+" />
                      </div>
                    </div>
                    <div className="flex gap-2 pt-1">
                      <Button size="sm" onClick={handleSaveFields} disabled={saving || !editTitle.trim()}>
                        {saving ? "Saving..." : "Save Changes"}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-5 pr-1">
                    {/* Description */}
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Description</p>
                      {selectedEco.description ? (
                        <p className="text-sm leading-relaxed whitespace-pre-wrap">{selectedEco.description}</p>
                      ) : (
                        <p className="text-sm text-muted-foreground/60 italic">No description provided.</p>
                      )}
                    </div>

                    <Separator />

                    {/* Metadata grid */}
                    <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                      <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Priority</p>
                        <Badge variant={priorityVariants[selectedEco.priority] || "muted"}>
                          {selectedEco.priority}
                        </Badge>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Status</p>
                        <Badge variant={statusVariants[selectedEco.status] || "muted"}>
                          {selectedEco.status.replace("_", " ")}
                        </Badge>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Reason for Change</p>
                        <p className="text-sm">{selectedEco.reason ? reasonLabels[selectedEco.reason] || selectedEco.reason : <span className="text-muted-foreground/60 italic">Not set</span>}</p>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Change Type</p>
                        <p className="text-sm">{selectedEco.changeType ? changeTypeLabelsEco[selectedEco.changeType] || selectedEco.changeType : <span className="text-muted-foreground/60 italic">Not set</span>}</p>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Cost Impact</p>
                        <p className="text-sm">{selectedEco.costImpact ? costImpactLabels[selectedEco.costImpact] || selectedEco.costImpact : <span className="text-muted-foreground/60 italic">Not set</span>}</p>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Disposition</p>
                        <p className="text-sm">{selectedEco.disposition ? dispositionLabels[selectedEco.disposition] || selectedEco.disposition : <span className="text-muted-foreground/60 italic">Not set</span>}</p>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Effectivity</p>
                        <p className="text-sm">{selectedEco.effectivity || <span className="text-muted-foreground/60 italic">Not set</span>}</p>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Created</p>
                        <p className="text-sm"><FormattedDate date={selectedEco.createdAt} /></p>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Last Updated</p>
                        <p className="text-sm"><FormattedDate date={selectedEco.updatedAt} /></p>
                      </div>
                      {selectedEco.createdBy && (
                        <div className="col-span-2">
                          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Created By</p>
                          <p className="text-sm">{selectedEco.createdBy.fullName} <span className="text-muted-foreground">({selectedEco.createdBy.email})</span></p>
                        </div>
                      )}
                    </div>

                    {selectedEco.status === "DRAFT" && (
                      <>
                        <Separator />
                        <Button size="sm" variant="outline" onClick={startEditing}>
                          <Pencil className="w-3.5 h-3.5 mr-1.5" />
                          Edit Details
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </ScrollArea>
            </TabsContent>

            {/* --- Affected Items Tab --- */}
            <TabsContent value="items" className="mt-4">
              <ScrollArea className="h-[calc(100vh-22rem)]">
                <div className="space-y-3 pr-1">
                  {selectedEco.status === "DRAFT" && (
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">
                        {items.length} file{items.length !== 1 ? "s" : ""} affected by this change
                      </p>
                      <Button size="sm" variant="outline" onClick={() => setShowAddItem(true)}>
                        <Plus className="w-3.5 h-3.5 mr-1.5" />Add File
                      </Button>
                    </div>
                  )}

                  {loadingItems ? (
                    <div className="flex justify-center py-12">
                      <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : items.length === 0 ? (
                    <div className="text-center py-12 text-muted-foreground">
                      <FileText className="w-10 h-10 mx-auto mb-3 opacity-30" />
                      <p className="font-medium text-sm">No affected items</p>
                      {selectedEco.status === "DRAFT" ? (
                        <p className="text-xs mt-1.5">Add the files that this ECO will change, add, or remove.</p>
                      ) : (
                        <p className="text-xs mt-1.5">No files were linked to this ECO.</p>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {items.map((item) => {
                        const ct = changeTypeLabels[item.changeType] || { label: item.changeType, variant: "info" as const };
                        return (
                          <div key={item.id} className="flex items-start gap-3 p-3 rounded-lg border bg-background group">
                            <FileText className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium truncate">{item.file.name}</span>
                                <Badge variant={ct.variant} className="text-[10px] shrink-0">{ct.label}</Badge>
                              </div>
                              <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                                {item.file.partNumber && <span>{item.file.partNumber}</span>}
                                {item.file.partNumber && <span>&middot;</span>}
                                <span>{item.file.lifecycleState}</span>
                                <span>&middot;</span>
                                <span>v{item.file.currentVersion}</span>
                              </div>
                              {item.reason && (
                                <p className="text-xs text-muted-foreground mt-1.5 italic">{item.reason}</p>
                              )}
                            </div>
                            {selectedEco.status === "DRAFT" && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 text-destructive shrink-0"
                                onClick={() => handleRemoveItem(item.id)}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </ScrollArea>
            </TabsContent>

            {/* --- Approval Tab --- */}
            <TabsContent value="approval" className="mt-4">
              <ScrollArea className="h-[calc(100vh-22rem)]">
                {loadingApproval ? (
                  <div className="flex justify-center py-12">
                    <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                  </div>
                ) : !approval ? (
                  <div className="text-center py-12 text-muted-foreground">
                    <Shield className="w-10 h-10 mx-auto mb-3 opacity-30" />
                    <p className="font-medium text-sm">No approval request</p>
                    <p className="text-xs mt-1.5">Submit the ECO to start an approval workflow (if one is configured).</p>
                  </div>
                ) : (
                  <div className="space-y-5 pr-1">
                    {/* Request header */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={approvalStatusConfig[approval.status]?.variant || "muted"}>
                        {approvalStatusConfig[approval.status]?.label || approval.status}
                      </Badge>
                      {approval.workflow && (
                        <span className="text-xs text-muted-foreground">Workflow: {approval.workflow.name}</span>
                      )}
                      <span className="text-xs text-muted-foreground">
                        Started <FormattedDate date={approval.createdAt} variant="date" />
                      </span>
                      {approval.completedAt && (
                        <span className="text-xs text-muted-foreground">
                          Completed <FormattedDate date={approval.completedAt} variant="date" />
                        </span>
                      )}
                    </div>

                    {/* Step progress bar */}
                    {approval.decisions.length > 1 && (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                          <span>Step {approval.currentStepOrder} of {approval.decisions.length}</span>
                          <span>
                            {approval.decisions.filter((d) => d.status === "APPROVED").length}/{approval.decisions.length} completed
                          </span>
                        </div>
                        <div className="flex gap-1">
                          {approval.decisions
                            .sort((a, b) => (a.step?.stepOrder || 0) - (b.step?.stepOrder || 0))
                            .map((d, i) => (
                              <div
                                key={i}
                                className={`h-2 flex-1 rounded-full transition-colors ${
                                  d.status === "APPROVED" ? "bg-green-500" :
                                  d.status === "REJECTED" ? "bg-red-500" :
                                  d.status === "PENDING" ? "bg-yellow-500 animate-pulse" :
                                  d.status === "REWORK" ? "bg-purple-500" :
                                  "bg-muted"
                                }`}
                                title={`Step ${d.step?.stepOrder}: ${d.group.name} — ${d.status}`}
                              />
                            ))}
                        </div>
                      </div>
                    )}

                    {/* Decision steps */}
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2.5">Approval Steps</p>
                      <div className="space-y-2">
                        {approval.decisions
                          .sort((a, b) => (a.step?.stepOrder || 0) - (b.step?.stepOrder || 0))
                          .map((d) => {
                            const stepNum = d.step?.stepOrder;
                            const dConfig = approvalStatusConfig[d.status] || approvalStatusConfig.PENDING;
                            return (
                              <div key={d.id} className="flex items-start gap-3 p-3 rounded-lg border">
                                {stepNum && (
                                  <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                                    d.status === "APPROVED" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" :
                                    d.status === "REJECTED" ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" :
                                    d.status === "PENDING" ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400" :
                                    "bg-muted"
                                  }`}>
                                    {d.status === "APPROVED" ? <CheckCircle className="w-4 h-4" /> :
                                     d.status === "REJECTED" ? <XCircle className="w-4 h-4" /> :
                                     d.status === "PENDING" ? <Clock className="w-4 h-4" /> :
                                     <span className="text-xs font-mono font-bold">{stepNum}</span>}
                                  </div>
                                )}
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm font-medium">{d.group.name}</span>
                                    <Badge variant={dConfig.variant} className="text-[9px]">{dConfig.label}</Badge>
                                    {d.approvalMode && d.approvalMode !== "ANY" && (
                                      <span className="text-[10px] text-muted-foreground">{modeLabels[d.approvalMode]}</span>
                                    )}
                                  </div>
                                  <p className="text-xs text-muted-foreground mt-0.5">
                                    {d.signatureLabel || "Approval"}
                                  </p>
                                  {d.decider && (
                                    <p className="text-xs mt-1">
                                      {d.decider.fullName} — <FormattedDate date={d.decidedAt!} />
                                    </p>
                                  )}
                                  {d.comment && (
                                    <div className="flex items-start gap-1.5 mt-1.5 text-xs text-muted-foreground bg-muted/30 rounded-md p-2">
                                      <MessageSquare className="w-3 h-3 mt-0.5 shrink-0" />
                                      <span>{d.comment}</span>
                                    </div>
                                  )}
                                  {d.deadlineAt && d.status === "PENDING" && (
                                    <p className={`text-[10px] mt-1.5 flex items-center gap-1 ${
                                      new Date(d.deadlineAt) < new Date() ? "text-red-500 font-medium" : "text-muted-foreground"
                                    }`}>
                                      <Clock className="w-3 h-3" />
                                      {new Date(d.deadlineAt) < new Date() ? "Overdue" : <>Deadline: <FormattedDate date={d.deadlineAt} /></>}
                                    </p>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    </div>

                    <Separator />

                    {/* Timeline */}
                    {approval.timeline && approval.timeline.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2.5">Timeline</p>
                        <div className="space-y-0 border-l-2 border-muted ml-2">
                          {approval.timeline.map((event) => (
                            <div key={event.id} className="flex gap-3 text-xs pl-4 py-2 relative">
                              <div className="absolute -left-1.25 top-3 w-2 h-2 rounded-full bg-muted-foreground/30" />
                              <div className="flex-1">
                                <span className="text-muted-foreground/60"><FormattedDate date={event.createdAt} /></span>
                                <p className="mt-0.5">
                                  {event.user && <span className="font-medium">{event.user.fullName}: </span>}
                                  <span className="text-muted-foreground">{event.details}</span>
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </ScrollArea>
            </TabsContent>
          </Tabs>
        </div>
      )}

      {/* Create ECO Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New Engineering Change Order</DialogTitle>
            <DialogDescription>Create an ECO to propose and track an engineering change.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate}>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Title</Label>
                <Input
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="e.g., Update Housing Assembly tolerance"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder="Describe the change and the reason for it..."
                  rows={3}
                />
              </div>
              <div className="space-y-2">
                <Label>Reason for Change</Label>
                <Select value={newReason} onValueChange={(v) => setNewReason(v ?? "")}>
                  <SelectTrigger><SelectValue placeholder="Select reason..." /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(reasonLabels).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Change Type</Label>
                  <Select value={newChangeType} onValueChange={(v) => setNewChangeType(v ?? "")}>
                    <SelectTrigger><SelectValue placeholder="Select type..." /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(changeTypeLabelsEco).map(([k, v]) => (
                        <SelectItem key={k} value={k}>{v}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Priority</Label>
                  <Select value={newPriority} onValueChange={(v) => setNewPriority(v ?? "MEDIUM")}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="LOW">Low</SelectItem>
                      <SelectItem value="MEDIUM">Medium</SelectItem>
                      <SelectItem value="HIGH">High</SelectItem>
                      <SelectItem value="CRITICAL">Critical</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button type="submit" disabled={creating || !newTitle.trim()}>
                {creating ? "Creating..." : "Create ECO"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Add Item Dialog */}
      <Dialog open={showAddItem} onOpenChange={(open) => { if (!open) { setShowAddItem(false); setSelectedFile(null); setFileSearch(""); setFileResults([]); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Affected File</DialogTitle>
            <DialogDescription>Select a file that will be changed, added, or removed by this ECO.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAddItem}>
            <div className="space-y-4 py-4">
              {/* File search */}
              <div className="space-y-2">
                <Label>File <span className="text-destructive">*</span></Label>
                {selectedFile ? (
                  <div className="flex items-center gap-3 p-3 border rounded-lg bg-muted/20">
                    <FileText className="w-5 h-5 text-primary shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{selectedFile.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {selectedFile.partNumber || "No part number"} &middot; {selectedFile.lifecycleState}
                      </p>
                    </div>
                    <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={() => { setSelectedFile(null); setFileSearch(""); }}>
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <div className="relative">
                      <Search className="absolute left-3 top-2.5 w-4 h-4 text-muted-foreground" />
                      <Input
                        value={fileSearch}
                        onChange={(e) => searchFiles(e.target.value)}
                        placeholder="Search files by name or part number..."
                        className="pl-9"
                        autoFocus
                      />
                    </div>
                    {searchingFiles && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Searching...
                      </div>
                    )}
                    {fileResults.length > 0 && (
                      <div className="border rounded-lg overflow-hidden max-h-48 overflow-y-auto">
                        {fileResults.map((f) => (
                          <button
                            key={f.id}
                            type="button"
                            className="w-full text-left px-3 py-2.5 text-sm hover:bg-muted/50 border-b last:border-0 flex items-center gap-3 transition-colors"
                            onClick={() => { setSelectedFile(f); setFileResults([]); }}
                          >
                            <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                            <div className="min-w-0 flex-1">
                              <span className="font-medium">{f.name}</span>
                              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                {f.partNumber && <span>{f.partNumber}</span>}
                                {f.partNumber && <span>&middot;</span>}
                                <span>{f.lifecycleState}</span>
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                    {fileSearch.length >= 2 && !searchingFiles && fileResults.length === 0 && (
                      <p className="text-xs text-muted-foreground/60 px-1 italic">No files found matching &ldquo;{fileSearch}&rdquo;</p>
                    )}
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label>Change Type <span className="text-destructive">*</span></Label>
                <Select value={itemChangeType} onValueChange={(v) => setItemChangeType(v ?? "MODIFY")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ADD">Add — New file being introduced</SelectItem>
                    <SelectItem value="MODIFY">Modify — Existing file being changed</SelectItem>
                    <SelectItem value="REMOVE">Remove — File being obsoleted</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Reason</Label>
                <Textarea
                  value={itemReason}
                  onChange={(e) => setItemReason(e.target.value)}
                  placeholder="Why is this file affected by the change?"
                  rows={2}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowAddItem(false)}>Cancel</Button>
              <Button type="submit" disabled={!selectedFile}>Add to ECO</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
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
