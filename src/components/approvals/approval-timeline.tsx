"use client";

import { Badge } from "@/components/ui/badge";
import { FormattedDate } from "@/components/ui/formatted-date";
import {
  Clock, CheckCircle, CheckCircle2, XCircle, Play, ArrowRight,
  Undo2, RotateCcw, Send, AlertTriangle, History,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Shared approval-timeline renderer. Used by both the ECO approval tab
 * and the approvals page request-detail dialog — any surface that renders
 * `approval_history` rows with per-event icons, colors, actor name, and
 * elapsed-time badges between consecutive events.
 *
 * Designed to consume the shape returned by `getRequestTimeline()` in
 * `lib/approval-engine.ts`. Pass an empty array to render the "no
 * timeline recorded" empty state — that path exists because legacy-path
 * approval requests created before the history fix don't have rows.
 */

export interface ApprovalTimelineEntry {
  id: string;
  event: string;
  details: string | null;
  createdAt: string;
  user: { fullName: string } | null;
}

interface ApprovalTimelineProps {
  events: ApprovalTimelineEntry[];
  /**
   * Message to show when `events` is empty. Defaults to a generic
   * "no timeline recorded" line. Callers can override when they know
   * why the timeline might be missing (e.g. legacy requests).
   */
  emptyMessage?: string;
}

export function ApprovalTimeline({
  events,
  emptyMessage = "No timeline events were recorded for this request.",
}: ApprovalTimelineProps) {
  if (events.length === 0) {
    return (
      <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/30 rounded-md p-3">
        <History className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>{emptyMessage}</span>
      </div>
    );
  }

  return (
    <ol className="space-y-0">
      {events.map((event, i) => {
        const prev = i > 0 ? events[i - 1] : null;
        const elapsedMs = prev
          ? new Date(event.createdAt).getTime() - new Date(prev.createdAt).getTime()
          : 0;
        return (
          <TimelineEventRow
            key={event.id}
            event={event}
            elapsedMs={elapsedMs}
            isFirst={i === 0}
            isLast={i === events.length - 1}
          />
        );
      })}
    </ol>
  );
}

// ─── Internals ────────────────────────────────────────────────────────────

interface TimelineEventRowProps {
  event: ApprovalTimelineEntry;
  elapsedMs: number;
  isFirst: boolean;
  isLast: boolean;
}

function TimelineEventRow({ event, elapsedMs, isFirst, isLast }: TimelineEventRowProps) {
  const style = eventStyles[event.event] || eventStyles.DEFAULT;
  const Icon = style.icon;

  // Defensive: old history rows (written before the engine stopped
  // prefixing the actor name) start with "Jane Doe: ...". Strip that if
  // it matches the current `user.fullName` so we don't render the name
  // twice — once in the header line, once inside details.
  const details = stripActorPrefix(event.details, event.user?.fullName);

  return (
    <li className="relative pl-8 pb-4 last:pb-0">
      {/* Vertical connector line — hidden on the last row so the timeline
          ends at its icon instead of trailing into empty space. */}
      {!isLast && (
        <span className="absolute left-3 top-6 bottom-0 w-px bg-border" aria-hidden />
      )}
      {/* Icon disc */}
      <span
        className={`absolute left-0 top-0.5 flex items-center justify-center w-6 h-6 rounded-full ${style.bg}`}
      >
        <Icon className="w-3.5 h-3.5" />
      </span>

      <div className="flex items-baseline gap-2 flex-wrap">
        <span className={`text-xs font-semibold ${style.label}`}>{style.title}</span>
        {event.user && (
          <span className="text-xs text-foreground">{event.user.fullName}</span>
        )}
        <span className="text-[10px] text-muted-foreground/60">
          <FormattedDate date={event.createdAt} />
        </span>
        {!isFirst && elapsedMs > 0 && (
          <Badge variant="secondary" className="text-[9px] px-1.5 py-0 font-normal">
            +{formatDuration(elapsedMs)}
          </Badge>
        )}
      </div>
      {details && (
        <p className="text-xs text-muted-foreground mt-0.5">{details}</p>
      )}
    </li>
  );
}

/**
 * Per-event-type visual config: the icon, the label shown in the timeline
 * row, and the colors for the icon disc and label text. `DEFAULT` catches
 * any event type the engine adds later that we haven't styled yet.
 */
const eventStyles: Record<
  string,
  { icon: LucideIcon; title: string; bg: string; label: string }
> = {
  CREATED: {
    icon: Play,
    title: "Created",
    bg: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
    label: "text-blue-700 dark:text-blue-300",
  },
  STEP_ACTIVATED: {
    icon: ArrowRight,
    title: "Step activated",
    bg: "bg-slate-100 text-slate-700 dark:bg-slate-900/50 dark:text-slate-300",
    label: "text-slate-700 dark:text-slate-300",
  },
  APPROVED: {
    icon: CheckCircle,
    title: "Approved",
    bg: "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300",
    label: "text-green-700 dark:text-green-300",
  },
  REJECTED: {
    icon: XCircle,
    title: "Rejected",
    bg: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300",
    label: "text-red-700 dark:text-red-300",
  },
  RECALLED: {
    icon: Undo2,
    title: "Recalled",
    bg: "bg-gray-100 text-gray-700 dark:bg-gray-900/50 dark:text-gray-300",
    label: "text-gray-700 dark:text-gray-300",
  },
  REWORK_REQUESTED: {
    icon: RotateCcw,
    title: "Rework requested",
    bg: "bg-purple-100 text-purple-700 dark:bg-purple-950/50 dark:text-purple-300",
    label: "text-purple-700 dark:text-purple-300",
  },
  RESUBMITTED: {
    icon: Send,
    title: "Resubmitted",
    bg: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
    label: "text-blue-700 dark:text-blue-300",
  },
  COMPLETED: {
    icon: CheckCircle2,
    title: "Completed",
    bg: "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300",
    label: "text-green-700 dark:text-green-300",
  },
  DEADLINE_WARNING: {
    icon: AlertTriangle,
    title: "Deadline warning",
    bg: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
    label: "text-amber-700 dark:text-amber-300",
  },
  DEFAULT: {
    icon: Clock,
    title: "Event",
    bg: "bg-muted text-muted-foreground",
    label: "text-foreground",
  },
};

/**
 * Strip a leading "Actor Name:" or "Actor Name " prefix from a details
 * string when it matches the event's actor. Backwards compat only — the
 * current engine no longer prefixes details with the name, but rows
 * written before the fix still do, and we don't want to render the
 * name twice for those.
 */
function stripActorPrefix(details: string | null, actorName?: string): string | null {
  if (!details) return details;
  if (!actorName) return details;
  if (details.startsWith(`${actorName}:`)) {
    return details.slice(actorName.length + 1).trimStart();
  }
  if (details.startsWith(`${actorName} `)) {
    return details.slice(actorName.length + 1).trimStart();
  }
  return details;
}

/**
 * Render a duration (ms) as a short human-readable string. Used for the
 * "+N since previous" badge on timeline rows and exported so the parent
 * surface can show an aggregate lifetime (e.g. "Took 2d 3h"). Tuned for
 * the granularity a manager cares about — "3m" and "1h" are useful,
 * "73843210ms" isn't.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    const m = min % 60;
    return m > 0 ? `${hr}h ${m}m` : `${hr}h`;
  }
  const days = Math.floor(hr / 24);
  if (days < 14) {
    const h = hr % 24;
    return h > 0 ? `${days}d ${h}h` : `${days}d`;
  }
  return `${days}d`;
}
