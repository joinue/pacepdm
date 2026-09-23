/**
 * Vercel Cron endpoint — sweeps for overdue approval steps and sends a
 * reminder in-app notification (which fans out to email via notify()).
 *
 * Schedule: every 30 min via vercel.json.
 * Auth: `withCron` — Vercel attaches `Authorization: Bearer ${CRON_SECRET}`;
 *       anything else, including a missing secret, is a 401.
 *
 * One reminder per *step*, not per decision row. An ALL or MAJORITY step
 * holds one decision row per seat (see startWorkflow), and deduping per row
 * sent a three-seat step's group three identical "Approval overdue" rows —
 * and three emails — each, in one run. The step's rows are claimed together
 * in `approval_reminders`, with the first row (by id) as the lock: whoever
 * inserts that one sends; the rest are recorded so a later run skips them.
 *
 * Only requests still PENDING are chased. A request sent back for rework
 * closes its open seats now, but rows from before that change are still
 * PENDING on a REWORK request, which the approvals page does not show.
 */

import { withCron } from "@/lib/api-route";
import { notify } from "@/lib/notifications";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Every reminder's emails go out through after(), one at a time, which is
// bounded by this. A hundred overdue steps is not a normal morning, but a
// sweep cut short mid-loop re-nags nobody — the claim is already written.
export const maxDuration = 300;

interface PendingDecision {
  id: string;
  requestId: string;
  stepId: string | null;
  groupId: string;
  deadlineAt: string;
  signatureLabel: string | null;
  request: {
    tenantId: string;
    title: string;
    status: string;
  } | null;
}

interface OverdueStep {
  requestId: string;
  groupId: string;
  deadlineAt: string;
  request: NonNullable<PendingDecision["request"]>;
  /** Sorted, so the first is the same row on every run. */
  decisionIds: string[];
}

export const GET = withCron({ name: "cron/approval-reminders" }, async ({ db }) => {
  const now = new Date().toISOString();

  const { data: decisions, error } = await db
    .from("approval_decisions")
    .select(
      "id, requestId, stepId, groupId, deadlineAt, signatureLabel, request:approval_requests!approval_decisions_requestId_fkey!inner(tenantId, title, status)"
    )
    .eq("status", "PENDING")
    .eq("request.status", "PENDING")
    .not("deadlineAt", "is", null)
    .lt("deadlineAt", now)
    .order("deadlineAt", { ascending: true })
    .limit(500);

  if (error) throw new Error(`overdue-decision query failed: ${error.message}`);

  const pending = (decisions || []) as unknown as PendingDecision[];
  if (pending.length === 0) {
    return { scanned: 0, reminded: 0 };
  }

  // Filter out steps we've already reminded on: any row of the step claimed
  // means the step was, including rows claimed one at a time before this
  // grouped per step.
  const ids = pending.map((d) => d.id);
  const { data: already } = await db
    .from("approval_reminders")
    .select("decisionId")
    .in("decisionId", ids)
    .eq("kind", "overdue");
  const alreadySet = new Set((already || []).map((r) => r.decisionId));

  const steps = groupByStep(pending).filter(
    (step) => !step.decisionIds.some((id) => alreadySet.has(id))
  );

  let reminded = 0;
  const errors: string[] = [];

  for (const step of steps) {
    // Claim the step before sending, so concurrent runs cannot both send.
    // The unique PK (decisionId, kind) makes the second insert of the lock
    // row fail harmlessly.
    const [lockId, ...rest] = step.decisionIds;
    const { error: claimErr } = await db
      .from("approval_reminders")
      .insert({ decisionId: lockId, kind: "overdue" });
    if (claimErr) {
      // 23505 = unique_violation — another worker already claimed it.
      if (!`${claimErr.code || ""}`.startsWith("235")) {
        errors.push(`claim ${lockId}: ${claimErr.message}`);
      }
      continue;
    }
    if (rest.length > 0) {
      // Best effort: a failure here only means a later run sees the lock
      // row and skips the step anyway.
      const { error: restErr } = await db
        .from("approval_reminders")
        .insert(rest.map((decisionId) => ({ decisionId, kind: "overdue" })));
      if (restErr && !`${restErr.code || ""}`.startsWith("235")) {
        errors.push(`claim seats of ${lockId}: ${restErr.message}`);
      }
    }

    const { data: members } = await db
      .from("approval_group_members")
      .select("userId")
      .eq("groupId", step.groupId);
    const userIds = [...new Set((members || []).map((m) => m.userId))];
    if (userIds.length === 0) continue;

    const overdueBy = Math.max(
      0,
      Math.floor((Date.now() - new Date(step.deadlineAt).getTime()) / 3600000)
    );

    try {
      await notify({
        tenantId: step.request.tenantId,
        userIds,
        title: "Approval overdue",
        message: `"${step.request.title}" is past its deadline${overdueBy > 0 ? ` by ${overdueBy}h` : ""}. Please review.`,
        type: "approval",
        link: "/approvals",
        refId: step.requestId,
      });
      reminded += 1;
    } catch (err) {
      errors.push(`notify ${lockId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    scanned: pending.length,
    reminded,
    errors: errors.length ? errors : undefined,
  };
});

/**
 * The step each decision row belongs to. Rows from before steps carried a
 * `stepId` fall back to grouping by request and group, which is the same
 * thing for any workflow that does not use one group on two steps.
 */
function groupByStep(pending: PendingDecision[]): OverdueStep[] {
  const byStep = new Map<string, OverdueStep>();
  for (const d of pending) {
    if (!d.request) continue;
    const key = `${d.requestId}:${d.stepId ?? d.groupId}`;
    const step = byStep.get(key);
    if (step) {
      step.decisionIds.push(d.id);
      if (d.deadlineAt < step.deadlineAt) step.deadlineAt = d.deadlineAt;
    } else {
      byStep.set(key, {
        requestId: d.requestId,
        groupId: d.groupId,
        deadlineAt: d.deadlineAt,
        request: d.request,
        decisionIds: [d.id],
      });
    }
  }
  for (const step of byStep.values()) step.decisionIds.sort();
  return [...byStep.values()];
}
