"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MentionInput } from "@/components/ui/mention-input";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  CheckCircle, XCircle, Clock, Shield, Loader2, RotateCcw,
  ChevronDown, ChevronRight, MessageSquare, Undo2,
} from "lucide-react";
import { FormattedDate } from "@/components/ui/formatted-date";
import { toast } from "sonner";

// --- Types ---

interface PendingDecision {
  id: string;
  groupId: string;
  status: string;
  signatureLabel: string | null;
  approvalMode: string | null;
  deadlineAt: string | null;
  group: { name: string };
  request: {
    id: string;
    type: string;
    entityType: string;
    entityId: string;
    title: string;
    description: string | null;
    status: string;
    createdAt: string;
    currentStepOrder: number;
    requestedBy: { fullName: string; email: string };
  };
}

interface MyRequest {
  id: string;
  title: string;
  status: string;
  entityType: string;
  currentStepOrder: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  workflow: { name: string } | null;
  decisions: {
    id: string;
    status: string;
    signatureLabel: string | null;
    group: { name: string };
  }[];
}

interface RequestDetail {
  id: string;
  title: string;
  description: string | null;
  status: string;
  type: string;
  entityType: string;
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

// --- Status helpers ---

const statusConfig: Record<string, { label: string; variant: "muted" | "warning" | "success" | "error" | "info" | "purple" }> = {
  PENDING: { label: "Pending", variant: "warning" },
  APPROVED: { label: "Approved", variant: "success" },
  REJECTED: { label: "Rejected", variant: "error" },
  RECALLED: { label: "Recalled", variant: "muted" },
  REWORK: { label: "Rework Needed", variant: "purple" },
  WAITING: { label: "Waiting", variant: "muted" },
};

const modeLabels: Record<string, string> = {
  ANY: "Any one member",
  ALL: "All members",
  MAJORITY: "Majority",
};

// --- Component ---

export default function ApprovalsPage() {
  const [tab, setTab] = useState<"pending" | "my-requests">("pending");
  const [pending, setPending] = useState<PendingDecision[]>([]);
  const [myRequests, setMyRequests] = useState<MyRequest[]>([]);
  const [loading, setLoading] = useState(true);

  // Decision action
  const [actionTarget, setActionTarget] = useState<{ decision: PendingDecision; action: "APPROVED" | "REJECTED" | "REWORK" } | null>(null);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Request detail view
  const [viewRequest, setViewRequest] = useState<RequestDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const loadPending = useCallback(async () => {
    const res = await fetch("/api/approvals");
    const data = await res.json();
    setPending(Array.isArray(data) ? data : []);
    setLoading(false);
  }, []);

  const loadMyRequests = useCallback(async () => {
    const res = await fetch("/api/approvals/requests");
    const data = await res.json();
    setMyRequests(Array.isArray(data) ? data : []);
  }, []);

  useEffect(() => { loadPending(); loadMyRequests(); }, [loadPending, loadMyRequests]);

  async function loadRequestDetail(requestId: string) {
    setLoadingDetail(true);
    const res = await fetch(`/api/approvals/requests?requestId=${requestId}`);
    const data = await res.json();
    setViewRequest(data);
    setLoadingDetail(false);
  }

  async function handleDecision() {
    if (!actionTarget) return;
    setSubmitting(true);

    const isRework = actionTarget.action === "REWORK";
    const body = isRework
      ? { rework: true, comment: comment.trim() }
      : { status: actionTarget.action, comment: comment.trim() || undefined };

    const res = await fetch(`/api/approvals/${actionTarget.decision.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) { const d = await res.json(); toast.error(d.error); setSubmitting(false); return; }

    const result = await res.json();
    toast.success(
      isRework ? "Rework requested — requester notified"
      : actionTarget.action === "APPROVED"
        ? result.requestComplete ? "Approved — all steps complete" : "Approved — next step activated"
        : "Rejected"
    );

    setActionTarget(null);
    setComment("");
    setSubmitting(false);
    loadPending();
    loadMyRequests();
  }

  async function handleRecall(requestId: string) {
    const res = await fetch("/api/approvals/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, action: "recall" }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success("Request recalled");
    loadMyRequests();
    loadPending();
  }

  async function handleResubmit(requestId: string) {
    const res = await fetch("/api/approvals/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, action: "resubmit" }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success("Resubmitted for approval");
    loadMyRequests();
    loadPending();
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Approvals</h2>
        <p className="text-sm text-muted-foreground mt-1">Review pending approvals and track your requests</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-muted/50 rounded-lg w-fit">
        <button
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${tab === "pending" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground"}`}
          onClick={() => setTab("pending")}
        >
          Needs My Review
          {pending.length > 0 && <Badge variant="error" className="text-[9px] ml-1.5 px-1.5 py-0">{pending.length}</Badge>}
        </button>
        <button
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${tab === "my-requests" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground"}`}
          onClick={() => setTab("my-requests")}
        >
          My Requests
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : tab === "pending" ? (
        /* ---- PENDING APPROVALS ---- */
        pending.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <CheckCircle className="w-10 h-10 mx-auto mb-3 text-green-500 opacity-50" />
              <p className="text-muted-foreground">No pending approvals. You&apos;re all caught up.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {pending.map((decision) => (
              <Card key={decision.id}>
                <CardContent className="p-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <Badge variant="outline" className="text-xs shrink-0">
                          <Shield className="w-3 h-3 mr-1" />
                          {decision.group.name}
                        </Badge>
                        {decision.signatureLabel && (
                          <Badge variant="secondary" className="text-xs shrink-0">
                            {decision.signatureLabel}
                          </Badge>
                        )}
                        {decision.approvalMode && decision.approvalMode !== "ANY" && (
                          <Badge variant="muted" className="text-[10px] shrink-0">
                            {modeLabels[decision.approvalMode] || decision.approvalMode}
                          </Badge>
                        )}
                        {decision.deadlineAt && (
                          <Badge variant={new Date(decision.deadlineAt) < new Date() ? "error" : "warning"} className="text-[10px] shrink-0">
                            <Clock className="w-3 h-3 mr-0.5" />
                            {new Date(decision.deadlineAt) < new Date() ? "Overdue" : <><span>Due </span><FormattedDate date={decision.deadlineAt} variant="date" /></>}
                          </Badge>
                        )}
                      </div>
                      <h3 className="font-medium">{decision.request.title}</h3>
                      {decision.request.description && (
                        <p className="text-sm text-muted-foreground mt-0.5">{decision.request.description}</p>
                      )}
                      <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                        <span>Requested by {decision.request.requestedBy.fullName}</span>
                        <span>&middot;</span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          <FormattedDate date={decision.request.createdAt} variant="date" />
                        </span>
                        {decision.request.currentStepOrder > 1 && (
                          <>
                            <span>&middot;</span>
                            <span>Step {decision.request.currentStepOrder}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-purple-600 border-purple-300 hover:bg-purple-50 dark:hover:bg-purple-950/30"
                        onClick={() => setActionTarget({ decision, action: "REWORK" })}
                      >
                        <RotateCcw className="w-4 h-4 mr-1" />
                        Rework
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive border-destructive/30 hover:bg-destructive/10"
                        onClick={() => setActionTarget({ decision, action: "REJECTED" })}
                      >
                        <XCircle className="w-4 h-4 mr-1" />
                        Reject
                      </Button>
                      <Button
                        variant="success"
                        size="sm"
                        onClick={() => setActionTarget({ decision, action: "APPROVED" })}
                      >
                        <CheckCircle className="w-4 h-4 mr-1" />
                        Approve
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )
      ) : (
        /* ---- MY REQUESTS ---- */
        myRequests.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Clock className="w-10 h-10 mx-auto mb-3 text-muted-foreground/30" />
              <p className="text-muted-foreground">You haven&apos;t submitted any approval requests yet.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {myRequests.map((req) => {
              const config = statusConfig[req.status] || statusConfig.PENDING;
              const totalSteps = req.decisions.filter((d) => d.signatureLabel).length || req.decisions.length;
              const completedSteps = req.decisions.filter((d) => d.status === "APPROVED").length;

              return (
                <Card key={req.id} className="cursor-pointer hover:border-foreground/20 transition-colors" onClick={() => loadRequestDetail(req.id)}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <Badge variant={config.variant} className="text-xs">{config.label}</Badge>
                          {req.workflow && <span className="text-[10px] text-muted-foreground">{req.workflow.name}</span>}
                        </div>
                        <h3 className="font-medium">{req.title}</h3>
                        <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                          <FormattedDate date={req.createdAt} variant="date" />
                          {totalSteps > 0 && (
                            <>
                              <span>&middot;</span>
                              <span>{completedSteps}/{totalSteps} steps</span>
                            </>
                          )}
                          {req.completedAt && (
                            <>
                              <span>&middot;</span>
                              <span>Completed <FormattedDate date={req.completedAt} variant="date" /></span>
                            </>
                          )}
                        </div>
                        {/* Step progress bar */}
                        {totalSteps > 1 && (
                          <div className="flex gap-1 mt-2">
                            {req.decisions.map((d, i) => (
                              <div key={i} className={`h-1.5 flex-1 rounded-full ${
                                d.status === "APPROVED" ? "bg-green-500" :
                                d.status === "REJECTED" ? "bg-red-500" :
                                d.status === "PENDING" ? "bg-yellow-500" :
                                d.status === "REWORK" ? "bg-purple-500" :
                                "bg-muted"
                              }`} />
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {req.status === "PENDING" && (
                          <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); handleRecall(req.id); }}>
                            <Undo2 className="w-3.5 h-3.5 mr-1" />
                            Recall
                          </Button>
                        )}
                        {req.status === "REWORK" && (
                          <Button variant="default" size="sm" onClick={(e) => { e.stopPropagation(); handleResubmit(req.id); }}>
                            <RotateCcw className="w-3.5 h-3.5 mr-1" />
                            Resubmit
                          </Button>
                        )}
                        <ChevronRight className="w-4 h-4 text-muted-foreground" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )
      )}

      {/* Decision dialog */}
      <Dialog open={!!actionTarget} onOpenChange={(open) => { if (!open) { setActionTarget(null); setComment(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {actionTarget?.action === "APPROVED" ? "Approve" : actionTarget?.action === "REWORK" ? "Request Rework" : "Reject"}
              : {actionTarget?.decision.request.title}
            </DialogTitle>
            <DialogDescription>
              {actionTarget?.action === "APPROVED"
                ? `Sign off as "${actionTarget?.decision.signatureLabel || "Approved"}". Add an optional comment.`
                : actionTarget?.action === "REWORK"
                ? "Send this back to the requester for changes. A comment explaining what needs to change is required."
                : "Provide a reason for rejection."}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <MentionInput
              value={comment}
              onChange={setComment}
              placeholder={
                actionTarget?.action === "APPROVED" ? "Optional comment... (use @ to mention someone)" :
                actionTarget?.action === "REWORK" ? "What needs to change?" :
                "Reason for rejection..."
              }
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setActionTarget(null); setComment(""); }}>Cancel</Button>
            <Button
              onClick={handleDecision}
              disabled={submitting || ((actionTarget?.action === "REJECTED" || actionTarget?.action === "REWORK") && !comment.trim())}
              variant={actionTarget?.action === "APPROVED" ? "success" : actionTarget?.action === "REWORK" ? "default" : "destructive"}
            >
              {submitting ? "Submitting..." : actionTarget?.action === "APPROVED" ? "Approve" : actionTarget?.action === "REWORK" ? "Request Rework" : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Request detail dialog with timeline */}
      <Dialog open={!!viewRequest} onOpenChange={(open) => { if (!open) setViewRequest(null); }}>
        <DialogContent className="max-w-lg">
          {loadingDetail ? (
            <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
          ) : viewRequest && (
            <>
              <DialogHeader>
                <DialogTitle>{viewRequest.title}</DialogTitle>
                <DialogDescription>
                  {viewRequest.workflow ? `Workflow: ${viewRequest.workflow.name}` : viewRequest.type}
                  {viewRequest.description && ` — ${viewRequest.description}`}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4 max-h-96 overflow-y-auto">
                {/* Status + actions */}
                <div className="flex items-center gap-2">
                  <Badge variant={statusConfig[viewRequest.status]?.variant || "muted"}>
                    {statusConfig[viewRequest.status]?.label || viewRequest.status}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    Requested by {viewRequest.requestedBy.fullName} on <FormattedDate date={viewRequest.createdAt} />
                  </span>
                </div>

                {/* Steps / Decisions */}
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Approval Steps</p>
                  <div className="space-y-2">
                    {viewRequest.decisions
                      .sort((a, b) => (a.step?.stepOrder || 0) - (b.step?.stepOrder || 0))
                      .map((d) => {
                        const stepNum = d.step?.stepOrder;
                        const dConfig = statusConfig[d.status] || statusConfig.PENDING;
                        return (
                          <div key={d.id} className="flex items-start gap-3 p-2 rounded-md border">
                            {stepNum && (
                              <div className="w-6 h-6 rounded-full bg-foreground/10 flex items-center justify-center text-xs font-mono font-bold shrink-0">
                                {stepNum}
                              </div>
                            )}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium">{d.group.name}</span>
                                <Badge variant={dConfig.variant} className="text-[9px]">{dConfig.label}</Badge>
                              </div>
                              <p className="text-xs text-muted-foreground mt-0.5">
                                {d.signatureLabel || "Approval"}
                                {d.approvalMode && d.approvalMode !== "ANY" && ` · ${modeLabels[d.approvalMode]}`}
                              </p>
                              {d.decider && (
                                <p className="text-xs mt-0.5">
                                  {d.decider.fullName} — <FormattedDate date={d.decidedAt!} />
                                </p>
                              )}
                              {d.comment && (
                                <div className="flex items-start gap-1 mt-1 text-xs text-muted-foreground">
                                  <MessageSquare className="w-3 h-3 mt-0.5 shrink-0" />
                                  <span>{d.comment}</span>
                                </div>
                              )}
                              {d.deadlineAt && d.status === "PENDING" && (
                                <p className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1">
                                  <Clock className="w-3 h-3" />
                                  Deadline: <FormattedDate date={d.deadlineAt} />
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
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Timeline</p>
                  <div className="space-y-2">
                    {viewRequest.timeline.map((event) => (
                      <div key={event.id} className="flex gap-2 text-xs">
                        <span className="text-muted-foreground shrink-0 w-32">
                          <FormattedDate date={event.createdAt} />
                        </span>
                        <div>
                          {event.user && <span className="font-medium">{event.user.fullName}: </span>}
                          <span className="text-muted-foreground">{event.details}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
