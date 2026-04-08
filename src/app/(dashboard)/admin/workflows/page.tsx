"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, GitBranch, ArrowDown, Clock, Shield, Link2 } from "lucide-react";
import { toast } from "sonner";

interface ApprovalGroup {
  id: string;
  name: string;
}

interface WorkflowStep {
  id: string;
  groupId: string;
  stepOrder: number;
  approvalMode: string;
  signatureLabel: string;
  deadlineHours: number | null;
  group: { id: string; name: string };
}

interface WorkflowAssignment {
  id: string;
  transitionId: string | null;
  ecoTrigger: string | null;
}

interface Workflow {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  steps: WorkflowStep[];
  assignments: WorkflowAssignment[];
}

interface Transition {
  id: string;
  name: string;
  lifecycleName: string;
  fromState: string;
  toState: string;
}

const MODES = [
  { value: "ANY", label: "Any one member", desc: "First person to approve moves it forward" },
  { value: "ALL", label: "All members", desc: "Every group member must approve" },
  { value: "MAJORITY", label: "Majority", desc: "50%+ of group must approve" },
];

const ECO_TRIGGERS = [
  { value: "SUBMITTED", label: "ECO Submitted", desc: "When an ECO is submitted for review" },
  { value: "IN_REVIEW", label: "ECO In Review", desc: "When an ECO enters the review phase" },
];

export default function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [groups, setGroups] = useState<ApprovalGroup[]>([]);
  const [transitions, setTransitions] = useState<Transition[]>([]);
  const [loading, setLoading] = useState(true);

  // Create workflow
  const [showCreate, setShowCreate] = useState(false);
  const [wfName, setWfName] = useState("");
  const [wfDesc, setWfDesc] = useState("");
  const [creating, setCreating] = useState(false);

  // Add step
  const [addStepTo, setAddStepTo] = useState<string | null>(null);
  const [stepGroupId, setStepGroupId] = useState("");
  const [stepMode, setStepMode] = useState("ANY");
  const [stepLabel, setStepLabel] = useState("Approved");
  const [stepDeadline, setStepDeadline] = useState("");

  // Add assignment
  const [addAssignTo, setAddAssignTo] = useState<string | null>(null);
  const [assignType, setAssignType] = useState<"transition" | "eco">("transition");
  const [assignTransitionId, setAssignTransitionId] = useState("");
  const [assignEcoTrigger, setAssignEcoTrigger] = useState("");

  const loadData = useCallback(async () => {
    const [wfRes, gRes, tRes] = await Promise.all([
      fetch("/api/workflows"),
      fetch("/api/approval-groups"),
      fetch("/api/lifecycle/transitions"),
    ]);
    const wfData = await wfRes.json();
    const gData = await gRes.json();
    const tData = await tRes.json();
    setWorkflows(Array.isArray(wfData) ? wfData : []);
    setGroups(Array.isArray(gData) ? gData : []);
    setTransitions(Array.isArray(tData) ? tData : []);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    const res = await fetch("/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: wfName, description: wfDesc }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); setCreating(false); return; }
    toast.success("Workflow created");
    setShowCreate(false); setWfName(""); setWfDesc(""); setCreating(false);
    loadData();
  }

  async function handleDeleteWorkflow(id: string) {
    const res = await fetch(`/api/workflows/${id}`, { method: "DELETE" });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success("Workflow deleted");
    loadData();
  }

  async function handleAddStep(e: React.FormEvent) {
    e.preventDefault();
    if (!addStepTo || !stepGroupId) return;
    const res = await fetch(`/api/workflows/${addStepTo}/steps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupId: stepGroupId,
        approvalMode: stepMode,
        signatureLabel: stepLabel || "Approved",
        deadlineHours: stepDeadline ? parseInt(stepDeadline) : null,
      }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success("Step added");
    setAddStepTo(null); setStepGroupId(""); setStepMode("ANY"); setStepLabel("Approved"); setStepDeadline("");
    loadData();
  }

  async function handleRemoveStep(workflowId: string, stepId: string) {
    await fetch(`/api/workflows/${workflowId}/steps`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stepId }),
    });
    toast.success("Step removed");
    loadData();
  }

  async function handleToggleActive(id: string, isActive: boolean) {
    await fetch(`/api/workflows/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !isActive }),
    });
    loadData();
  }

  async function handleAddAssignment(e: React.FormEvent) {
    e.preventDefault();
    if (!addAssignTo) return;

    const body: Record<string, string> = { workflowId: addAssignTo };
    if (assignType === "transition") {
      if (!assignTransitionId) return;
      body.transitionId = assignTransitionId;
    } else {
      if (!assignEcoTrigger) return;
      body.ecoTrigger = assignEcoTrigger;
    }

    const res = await fetch("/api/workflows/assignments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success("Assignment added");
    setAddAssignTo(null); setAssignTransitionId(""); setAssignEcoTrigger(""); setAssignType("transition");
    loadData();
  }

  async function handleRemoveAssignment(assignmentId: string) {
    await fetch("/api/workflows/assignments", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignmentId }),
    });
    toast.success("Assignment removed");
    loadData();
  }

  function getTransitionLabel(transitionId: string) {
    const t = transitions.find((tr) => tr.id === transitionId);
    if (!t) return "Unknown transition";
    return `${t.fromState} → ${t.toState}`;
  }

  function getTransitionSublabel(transitionId: string) {
    const t = transitions.find((tr) => tr.id === transitionId);
    return t ? `${t.lifecycleName} · ${t.name}` : "";
  }

  if (loading) return <div className="flex justify-center py-12"><div className="w-5 h-5 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin" /></div>;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Approval Workflows</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Define reusable approval sequences with ordered steps, modes, and deadlines
          </p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="w-4 h-4 mr-2" />
          New Workflow
        </Button>
      </div>

      {groups.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <Shield className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">Create approval groups first (Admin &gt; Approval Groups), then build workflows here.</p>
          </CardContent>
        </Card>
      )}

      {workflows.length === 0 && groups.length > 0 && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <GitBranch className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No workflows yet. Create one to define approval sequences.</p>
          </CardContent>
        </Card>
      )}

      <div className="space-y-4">
        {workflows.map((wf) => (
          <Card key={wf.id} className={!wf.isActive ? "opacity-60" : ""}>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <GitBranch className="w-4 h-4 text-primary" />
                    {wf.name}
                    {!wf.isActive && <Badge variant="muted" className="text-[10px]">Inactive</Badge>}
                  </CardTitle>
                  {wf.description && <CardDescription className="mt-1">{wf.description}</CardDescription>}
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => handleToggleActive(wf.id, wf.isActive)}>
                    {wf.isActive ? "Deactivate" : "Activate"}
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive" onClick={() => handleDeleteWorkflow(wf.id)}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0 space-y-5">
              {/* Steps */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Steps</p>
                  <Button variant="outline" size="sm" className="h-6 text-xs px-2" onClick={() => setAddStepTo(wf.id)}>
                    <Plus className="w-3 h-3 mr-1" />Add Step
                  </Button>
                </div>

                {wf.steps.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic py-2">No steps — add at least one approval step</p>
                ) : (
                  <div className="space-y-1">
                    {wf.steps.map((step, idx) => (
                      <div key={step.id}>
                        {idx > 0 && (
                          <div className="flex items-center gap-2 pl-4 py-0.5">
                            <ArrowDown className="w-3 h-3 text-muted-foreground" />
                            <span className="text-[10px] text-muted-foreground">then</span>
                          </div>
                        )}
                        <div className="flex items-center gap-3 p-2 rounded-md border bg-muted/20 group">
                          <div className="w-6 h-6 rounded-full bg-foreground/10 flex items-center justify-center text-xs font-mono font-bold shrink-0">
                            {step.stepOrder}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">{step.group.name}</span>
                              <Badge variant="secondary" className="text-[9px] px-1.5 py-0">
                                {MODES.find((m) => m.value === step.approvalMode)?.label || step.approvalMode}
                              </Badge>
                            </div>
                            <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                              <span>Signature: &ldquo;{step.signatureLabel}&rdquo;</span>
                              {step.deadlineHours && (
                                <span className="flex items-center gap-1">
                                  <Clock className="w-3 h-3" />
                                  {step.deadlineHours}h deadline
                                </span>
                              )}
                            </div>
                          </div>
                          <Button variant="ghost" size="sm" className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 text-destructive" onClick={() => handleRemoveStep(wf.id, step.id)}>
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <Separator />

              {/* Assignments */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Trigger Assignments</p>
                  <Button variant="outline" size="sm" className="h-6 text-xs px-2" onClick={() => { setAddAssignTo(wf.id); setAssignType("transition"); setAssignTransitionId(""); setAssignEcoTrigger(""); }}>
                    <Plus className="w-3 h-3 mr-1" />Assign
                  </Button>
                </div>

                {wf.assignments.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic py-2">No triggers — assign this workflow to transitions or ECO events</p>
                ) : (
                  <div className="space-y-1">
                    {wf.assignments.map((a) => (
                      <div key={a.id} className="flex items-center gap-3 p-2 rounded-md border bg-muted/20 group">
                        <Link2 className="w-4 h-4 text-muted-foreground shrink-0" />
                        <div className="flex-1 min-w-0">
                          {a.transitionId ? (
                            <div>
                              <div className="flex items-center gap-2">
                                <Badge variant="info" className="text-[9px]">File Transition</Badge>
                                <span className="text-sm font-medium">{getTransitionLabel(a.transitionId)}</span>
                              </div>
                              <p className="text-xs text-muted-foreground mt-0.5">{getTransitionSublabel(a.transitionId)}</p>
                            </div>
                          ) : a.ecoTrigger ? (
                            <div className="flex items-center gap-2">
                              <Badge variant="warning" className="text-[9px]">ECO</Badge>
                              <span className="text-sm font-medium">
                                {ECO_TRIGGERS.find((t) => t.value === a.ecoTrigger)?.label || a.ecoTrigger}
                              </span>
                            </div>
                          ) : (
                            <span className="text-sm text-muted-foreground">Unknown trigger</span>
                          )}
                        </div>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 text-destructive" onClick={() => handleRemoveAssignment(a.id)}>
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Create Workflow Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Approval Workflow</DialogTitle>
            <DialogDescription>Create a reusable approval sequence. Add steps after creating it.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate}>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input value={wfName} onChange={(e) => setWfName(e.target.value)} placeholder='e.g., "Full Release Review"' required />
              </div>
              <div className="space-y-2">
                <Label>Description (optional)</Label>
                <Textarea value={wfDesc} onChange={(e) => setWfDesc(e.target.value)} placeholder="When should this workflow be used?" rows={2} />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button type="submit" disabled={creating || !wfName.trim()}>{creating ? "Creating..." : "Create"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Add Step Dialog */}
      <Dialog open={!!addStepTo} onOpenChange={(open) => !open && setAddStepTo(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Approval Step</DialogTitle>
            <DialogDescription>
              Steps run in order. Each step requires an approval group to sign off before the next step activates.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAddStep}>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Approval Group</Label>
                <Select value={stepGroupId} onValueChange={(v) => setStepGroupId(v ?? "")}>
                  <SelectTrigger><SelectValue placeholder="Select group..." /></SelectTrigger>
                  <SelectContent>
                    {groups.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Approval Mode</Label>
                <Select value={stepMode} onValueChange={(v) => setStepMode(v ?? "ANY")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {MODES.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        <div>
                          <span>{m.label}</span>
                          <span className="text-xs text-muted-foreground ml-2">{m.desc}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Signature Label</Label>
                <Input value={stepLabel} onChange={(e) => setStepLabel(e.target.value)} placeholder='e.g., "Design Verified"' />
                <p className="text-xs text-muted-foreground">This label appears on the approval record, like a sign-off block on a drawing.</p>
              </div>
              <div className="space-y-2">
                <Label>Deadline (hours, optional)</Label>
                <Input type="number" value={stepDeadline} onChange={(e) => setStepDeadline(e.target.value)} placeholder="e.g., 72" min="1" />
                <p className="text-xs text-muted-foreground">If set, approvers will be reminded when the deadline approaches.</p>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddStepTo(null)}>Cancel</Button>
              <Button type="submit" disabled={!stepGroupId}>Add Step</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Add Assignment Dialog */}
      <Dialog open={!!addAssignTo} onOpenChange={(open) => { if (!open) { setAddAssignTo(null); setAssignTransitionId(""); setAssignEcoTrigger(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign Workflow Trigger</DialogTitle>
            <DialogDescription>
              Choose when this workflow should be activated. It will start automatically when the selected trigger occurs.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAddAssignment}>
            <div className="space-y-4 py-4">
              {/* Trigger type selector */}
              <div className="space-y-2">
                <Label>Trigger Type</Label>
                <div className="flex gap-1 p-1 bg-muted/50 rounded-lg">
                  <button
                    type="button"
                    className={`flex-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                      assignType === "transition" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground"
                    }`}
                    onClick={() => { setAssignType("transition"); setAssignEcoTrigger(""); }}
                  >
                    File Transition
                  </button>
                  <button
                    type="button"
                    className={`flex-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                      assignType === "eco" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground"
                    }`}
                    onClick={() => { setAssignType("eco"); setAssignTransitionId(""); }}
                  >
                    ECO Event
                  </button>
                </div>
              </div>

              {assignType === "transition" ? (
                <div className="space-y-2">
                  <Label>Lifecycle Transition</Label>
                  <Select value={assignTransitionId} onValueChange={(v) => setAssignTransitionId(v ?? "")}>
                    <SelectTrigger><SelectValue placeholder="Select transition..." /></SelectTrigger>
                    <SelectContent>
                      {transitions.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          <div className="flex items-center gap-2">
                            <span>{t.fromState} → {t.toState}</span>
                            <span className="text-xs text-muted-foreground">({t.lifecycleName})</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">This workflow will start when a file undergoes this lifecycle transition.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <Label>ECO Trigger</Label>
                  <Select value={assignEcoTrigger} onValueChange={(v) => setAssignEcoTrigger(v ?? "")}>
                    <SelectTrigger><SelectValue placeholder="Select trigger..." /></SelectTrigger>
                    <SelectContent>
                      {ECO_TRIGGERS.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          <div>
                            <span>{t.label}</span>
                            <span className="text-xs text-muted-foreground ml-2">{t.desc}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">This workflow will start when an ECO status changes to this value.</p>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddAssignTo(null)}>Cancel</Button>
              <Button
                type="submit"
                disabled={assignType === "transition" ? !assignTransitionId : !assignEcoTrigger}
              >
                Assign
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
