"use client";

import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FormattedDate } from "@/components/ui/formatted-date";
import {
  Loader2, CheckCircle, XCircle, Clock, Shield, MessageSquare,
} from "lucide-react";
import { approvalStatusConfig, modeLabels } from "../constants";
import type { ApprovalData, ApprovalDecision } from "../types";
import { ApprovalTimeline, formatDuration } from "@/components/approvals/approval-timeline";

interface EcoApprovalTabProps {
  approval: ApprovalData | null;
  loading: boolean;
}

/**
 * "Approval" tab. Renders the approval workflow status: a step progress
 * bar, the per-step decisions (with status, comments, deadlines), and a
 * timeline of events.
 *
 * The data shape comes from `/api/ecos/{id}/approval` and is computed
 * server-side from the workflow engine.
 */
export function EcoApprovalTab({ approval, loading }: EcoApprovalTabProps) {
  if (loading) {
    return (
      <ScrollArea className="h-[calc(100vh-22rem)]">
        <div className="flex justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      </ScrollArea>
    );
  }

  if (!approval) {
    return (
      <ScrollArea className="h-[calc(100vh-22rem)]">
        <div className="text-center py-12 text-muted-foreground">
          <Shield className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="font-medium text-sm">No approval request</p>
          <p className="text-xs mt-1.5">
            Submit the ECO to start an approval workflow (if one is configured).
          </p>
        </div>
      </ScrollArea>
    );
  }

  const sortedDecisions = [...approval.decisions].sort(
    (a, b) => (a.step?.stepOrder || 0) - (b.step?.stepOrder || 0)
  );
  const completedCount = approval.decisions.filter((d) => d.status === "APPROVED").length;
  const showProgress = approval.decisions.length > 1;

  // For completed requests we can show a concrete "took N" duration
  // (both timestamps come from props, so the subtraction is pure). For
  // open requests we'd need Date.now(), which React 19 forbids during
  // render — instead we show the start time and let the user read the
  // relative "X ago" from FormattedDate.
  const completedDurationMs = approval.completedAt
    ? new Date(approval.completedAt).getTime() - new Date(approval.createdAt).getTime()
    : null;

  return (
    <ScrollArea className="h-[calc(100vh-22rem)]">
      <div className="space-y-5 pr-1">
        {/* Request header — status badge, workflow name, and the lifetime
            of the request. The age field resolves the "how long has this
            been sitting there?" question without scrolling the timeline. */}
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
          {approval.completedAt && completedDurationMs !== null && (
            <>
              <span className="text-xs text-muted-foreground">
                &middot; Took{" "}
                <span className="font-medium text-foreground">
                  {formatDuration(completedDurationMs)}
                </span>
              </span>
              <span className="text-xs text-muted-foreground">
                Completed <FormattedDate date={approval.completedAt} variant="date" />
              </span>
            </>
          )}
        </div>

        {/* Step progress bar */}
        {showProgress && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              <span>Step {approval.currentStepOrder} of {approval.decisions.length}</span>
              <span>{completedCount}/{approval.decisions.length} completed</span>
            </div>
            <div className="flex gap-1">
              {sortedDecisions.map((d, i) => (
                <div
                  key={i}
                  className={`h-2 flex-1 rounded-full transition-colors ${stepBarColor(d.status)}`}
                  title={`Step ${d.step?.stepOrder}: ${d.group.name} — ${d.status}`}
                />
              ))}
            </div>
          </div>
        )}

        {/* Decision steps */}
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2.5">
            Approval Steps
          </p>
          <div className="space-y-2">
            {sortedDecisions.map((d) => <DecisionRow key={d.id} decision={d} />)}
          </div>
        </div>

        <Separator />

        {/* Timeline — uses the shared renderer so the approvals-page
            dialog and the ECO tab stay visually in lock-step. */}
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2.5">
            Timeline
          </p>
          <ApprovalTimeline events={approval.timeline || []} />
        </div>
      </div>
    </ScrollArea>
  );
}

/**
 * Single approval-step row. Pulled out so the parent stays focused on
 * layout and the step rendering details (icon, deadline, comment) live
 * in one place.
 */
function DecisionRow({ decision: d }: { decision: ApprovalDecision }) {
  const dConfig = approvalStatusConfig[d.status] || approvalStatusConfig.PENDING;
  const stepNum = d.step?.stepOrder;
  const isOverdue = d.deadlineAt && d.status === "PENDING" && new Date(d.deadlineAt) < new Date();

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg border">
      {stepNum && (
        <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${stepIconBg(d.status)}`}>
          {stepIcon(d.status, stepNum)}
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
          <p className={`text-[10px] mt-1.5 flex items-center gap-1 ${isOverdue ? "text-red-500 font-medium" : "text-muted-foreground"}`}>
            <Clock className="w-3 h-3" />
            {isOverdue
              ? "Overdue"
              : <>Deadline: <FormattedDate date={d.deadlineAt} /></>
            }
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Style helpers — kept here so the component reads top-to-bottom ────────

function stepBarColor(status: string): string {
  switch (status) {
    case "APPROVED": return "bg-green-500";
    case "REJECTED": return "bg-red-500";
    case "PENDING": return "bg-yellow-500 animate-pulse";
    case "REWORK": return "bg-purple-500";
    default: return "bg-muted";
  }
}

function stepIconBg(status: string): string {
  switch (status) {
    case "APPROVED": return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400";
    case "REJECTED": return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
    case "PENDING": return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400";
    default: return "bg-muted";
  }
}

function stepIcon(status: string, stepNum: number): React.ReactNode {
  if (status === "APPROVED") return <CheckCircle className="w-4 h-4" />;
  if (status === "REJECTED") return <XCircle className="w-4 h-4" />;
  if (status === "PENDING") return <Clock className="w-4 h-4" />;
  return <span className="text-xs font-mono font-bold">{stepNum}</span>;
}
