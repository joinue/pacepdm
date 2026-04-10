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
  ChevronRight, MessageSquare, Undo2,
} from "lucide-react";
import { FormattedDate } from "@/components/ui/formatted-date";
import { EmptyState } from "@/components/ui/empty-state";
import { fetchJson, errorMessage, isAbortError } from "@/lib/api-client";
import { toast } from "sonner";
import { ApprovalTimeline } from "@/components/approvals/approval-timeline";
import { useRealtimeTable } from "@/hooks/use-realtime-table";

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

  // Fetch helpers — declared as plain functions so they can be reused for
  // explicit refresh after mutations. They accept an optional AbortSignal.
  const fetchPending = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await fetchJson<PendingDecision[]>("/api/approvals", { signal });
      setPending(Array.isArray(data) ? data : []);
    } catch (err) {
      if (!isAbortError(err)) toast.error(errorMessage(err) || "Failed to load approvals");
    }
  }, []);

  const fetchMyRequests = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await fetchJson<MyRequest[]>("/api/approvals/requests", { signal });
      setMyRequests(Array.isArray(data) ? data : []);
    } catch (err) {
      if (!isAbortError(err)) toast.error(errorMessage(err) || "Failed to load requests");
    }
  }, []);

  // Initial load — abort on unmount to avoid setting state on a dead component
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetchPending(controller.signal),
      fetchMyRequests(controller.signal),
    ]).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [fetchPending, fetchMyRequests]);

  // ─── Realtime ────────────────────────────────────────────────────────
  //
  // Approvals is the one surface where staleness is a correctness bug,
  // not just an annoyance: two reviewers looking at the same queue will
  // collide if one claims an item and the other's list doesn't update.
  // Subscribing to `approval_decisions` (any change) and
  // `approval_requests` (status flips when a request completes) keeps
  // both tabs — "Pending" and "My Requests" — in sync across sessions.
  // No tenantId filter because neither table carries the column; RLS
  // and the server route already enforce scoping.
  useRealtimeTable({
    table: "approval_decisions",
    onChange: () => {
      void fetchPending();
      void fetchMyRequests();
    },
  });
  useRealtimeTable({
    table: "approval_requests",
    onChange: () => {
      void fetchPending();
      void fetchMyRequests();
    },
  });

  async function loadRequestDetail(requestId: string) {
    setLoadingDetail(true);
    try {
      const data = await fetchJson<RequestDetail>(`/api/approvals/requests?requestId=${requestId}`);
      setViewRequest(data);
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to load request details");
    } finally {
      setLoadingDetail(false);
    }
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
    fetchPending();
    fetchMyRequests();
  }

  async function handleRecall(requestId: string) {
    try {
      await fetchJson("/api/approvals/requests", {
        method: "POST",
        body: { requestId, action: "recall" },
      });
      toast.success("Request recalled");
      fetchMyRequests();
      fetchPending();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function handleResubmit(requestId: string) {
    try {
      await fetchJson("/api/approvals/requests", {
        method: "POST",
        body: { requestId, action: "resubmit" },
      });
      toast.success("Resubmitted for approval");
      fetchMyRequests();
      fetchPending();
    } catch (err) {
      toast.error(errorMessage(err));
    }
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
            <CardContent className="py-0">
              <EmptyState
                icon={CheckCircle}
                title="All caught up"
                description="No pending approvals require your attention."
              />
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
            <CardContent className="py-0">
              <EmptyState
                icon={Clock}
                title="No requests yet"
                description="You haven't submitted any approval requests."
              />
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

                {/* Timeline — rendered via the shared component so the
                    ECO approval tab and this dialog stay in visual sync.
                    Requests created via the legacy approval path prior
                    to the engine fix won't have any history rows; the
                    shared component surfaces a clear message in that
                    case instead of rendering an empty section. */}
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Timeline</p>
                  <ApprovalTimeline
                    events={viewRequest.timeline}
                    emptyMessage="No timeline events were recorded. This request was created before timeline tracking was added to the legacy approval path — new requests will populate a full timeline."
                  />
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
