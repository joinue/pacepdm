import { getServiceClient } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import {
  notify,
  notifyApprovalGroupMembers,
  notifyFileTransition,
  markNotificationsReadByRef,
} from "@/lib/notifications";
import { v4 as uuid } from "uuid";
import { blocksSelfApproval, selfApprovalRefusal } from "@/lib/self-approval";
import { nextRevision } from "@/lib/revision";
import {
  ECO_STATUS_LABELS,
  ECO_STATUSES_AWAITING_APPROVAL,
  ecoAwaitsApproval,
} from "@/lib/status-flows";

/**
 * Core approval workflow engine.
 * Handles: starting workflows, advancing steps, evaluating approval modes,
 * recall, reject-and-rework, and completing requests.
 */

interface StartWorkflowParams {
  tenantId: string;
  userId: string;
  userFullName: string;
  workflowId: string;
  type: string; // FILE_TRANSITION, ECO
  entityType: string; // file, eco
  entityId: string;
  transitionId?: string;
  title: string;
  description: string;
  /**
   * Optional idempotency token from the caller. If a request with the
   * same (tenantId, clientRequestKey) already exists, startWorkflow
   * returns that request's ID instead of creating a duplicate. Lets
   * clients safely retry on network errors and lets the UI debounce
   * double-clicked approve buttons without server-side coordination.
   */
  clientRequestKey?: string;
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

/** Start a new approval workflow — creates request, activates step 1 */
export async function startWorkflow(params: StartWorkflowParams) {
  const db = getServiceClient();
  const now = new Date().toISOString();
  const requestId = uuid();

  // Idempotency short-circuit: if the caller passed a key and a request
  // with that (tenantId, key) already exists, return it instead of
  // creating a duplicate. We do an explicit pre-check to avoid the
  // common-case unique-violation error path.
  if (params.clientRequestKey) {
    const { data: existing } = await db
      .from("approval_requests")
      .select("id")
      .eq("tenantId", params.tenantId)
      .eq("clientRequestKey", params.clientRequestKey)
      .maybeSingle();
    if (existing) {
      return {
        success: true,
        requestId: existing.id,
        pendingApproval: true,
        message: "Approval workflow already started",
      };
    }
  }

  // Entity-level guard: a given (entity, transition) can only have one
  // PENDING request at a time. Without this, a user who double-clicks
  // the Transition button creates two approval_requests and the group
  // gets "Approval Required" twice. The clientRequestKey guard above
  // only kicks in when the client sends a key — not all callers do.
  {
    let q = db
      .from("approval_requests")
      .select("id")
      .eq("tenantId", params.tenantId)
      .eq("entityType", params.entityType)
      .eq("entityId", params.entityId)
      .eq("status", "PENDING");
    q = params.transitionId
      ? q.eq("transitionId", params.transitionId)
      : q.is("transitionId", null);
    const { data: existing } = await q.maybeSingle();
    if (existing) {
      return {
        success: true,
        requestId: existing.id,
        pendingApproval: true,
        message: "Approval workflow already started",
      };
    }
  }

  // Get workflow steps
  const { data: steps } = await db
    .from("approval_workflow_steps")
    .select("*, group:approval_groups!approval_workflow_steps_groupId_fkey(id, name)")
    .eq("workflowId", params.workflowId)
    .order("stepOrder");

  if (!steps || steps.length === 0) {
    return { success: false, error: "Workflow has no steps" };
  }

  // Work out every step's seats before writing anything.
  //
  // **How many rows a step gets is what makes ALL and MAJORITY work.**
  // A decision row can only ever record one decider — `processDecision`
  // claims it with a compare-and-swap on `status = 'PENDING'` and stamps a
  // single `deciderId`. So a step needing several approvers needs several
  // rows, one per member of its group.
  //
  // With a single row per step regardless of mode (the previous shape),
  // ALL deadlocked with two or more members and MAJORITY with three or
  // more: the one row was claimed by the first approver, the step's
  // "everyone has approved" test could never see a second decider, and no
  // one else could act because the row was no longer PENDING. The request
  // sat PENDING forever with no way out but a recall. Both modes are
  // offered in Admin → Workflows, so the configuration was reachable.
  //
  // The approver set is frozen here rather than re-read when each decision
  // lands. Someone added to the group mid-flight does not gain a vote on a
  // request that was already out, and — more to the point — someone
  // *removed* cannot leave an ALL step permanently one approval short.
  //
  // This used to run after the request row was inserted, so an empty group
  // returned an error *and* left a PENDING request behind with no seats.
  // The entity guard above then handed that husk back to every later
  // attempt as "already started", and the ECO route refuses direct status
  // changes while a request is pending — so the entity was locked.
  const seatsByStep = new Map<string, number>();
  for (const step of steps as WorkflowStep[]) {
    let seats = 1;
    if (step.approvalMode === "ALL" || step.approvalMode === "MAJORITY") {
      const { data: members } = await db
        .from("approval_group_members")
        .select("userId")
        .eq("groupId", step.groupId);
      seats = (members ?? []).length;

      // An empty group cannot satisfy either mode. Failing here beats
      // creating a request that can never complete — and the file or ECO
      // stays in its current state instead of being stranded mid-flow.
      if (seats === 0) {
        return {
          success: false,
          error:
            `Approval step ${step.stepOrder} ("${step.signatureLabel || "Approved"}") uses ` +
            `${step.approvalMode} mode but its group has no members. Add members in ` +
            `Admin → Approval Groups, or change the step to "Any one member".`,
        };
      }
    }
    seatsByStep.set(step.id, seats);
  }

  // Create the approval request. The unique partial index on
  // (tenantId, clientRequestKey) is the second line of defense against
  // a race between the pre-check above and this insert: if another
  // caller landed first, this insert hits 23505 and we re-fetch instead
  // of double-creating.
  const { error: insertErr } = await db.from("approval_requests").insert({
    id: requestId,
    tenantId: params.tenantId,
    type: params.type,
    entityType: params.entityType,
    entityId: params.entityId,
    transitionId: params.transitionId || null,
    requestedById: params.userId,
    workflowId: params.workflowId,
    currentStepOrder: 1,
    status: "PENDING",
    title: params.title,
    description: params.description,
    clientRequestKey: params.clientRequestKey || null,
    createdAt: now,
    updatedAt: now,
  });

  if (insertErr) {
    if (insertErr.code === "23505" && params.clientRequestKey) {
      const { data: existing } = await db
        .from("approval_requests")
        .select("id")
        .eq("tenantId", params.tenantId)
        .eq("clientRequestKey", params.clientRequestKey)
        .maybeSingle();
      if (existing) {
        return {
          success: true,
          requestId: existing.id,
          pendingApproval: true,
          message: "Approval workflow already started",
        };
      }
    }
    // Any other rejection used to fall through to inserting seats for a
    // request row that did not exist.
    return {
      success: false,
      error: `Could not create the approval request: ${insertErr.message}`,
    };
  }

  // Create decisions for every step (only step 1 starts active), using the
  // seat counts worked out above.
  for (const step of steps as WorkflowStep[]) {
    const deadlineAt = step.deadlineHours
      ? new Date(Date.now() + step.deadlineHours * 3600000).toISOString()
      : null;
    const isFirst = step.stepOrder === 1;
    const seats = seatsByStep.get(step.id) ?? 1;

    for (let seat = 0; seat < seats; seat++) {
      const { error } = await db.from("approval_decisions").insert({
        id: uuid(),
        requestId,
        groupId: step.groupId,
        stepId: step.id,
        signatureLabel: step.signatureLabel,
        approvalMode: step.approvalMode,
        deadlineAt: isFirst ? deadlineAt : null, // Only the active step is on the clock
        status: isFirst ? "PENDING" : "WAITING", // WAITING = not yet active
        createdAt: now,
      });

      // Hard failure, for the same reason the empty-group check above is one:
      // a request holding fewer decision rows than the step has seats can
      // never satisfy ALL or MAJORITY. It would sit PENDING with no exit but
      // a recall, and the entity would be stranded pre-transition — which is
      // finding 4 in docs/plans/functional-audit.md, arrived at by a
      // different route.
      //
      // The request row already exists by now, so it is removed on the way
      // out. Left in place it is a PENDING request the entity guard above
      // hands back to every retry as "already started".
      if (error) {
        const leftBehind = await discardRequest(requestId);
        return {
          success: false,
          error:
            `Could not create approval seat ${seat + 1} of ${seats} for step ` +
            `${step.stepOrder}: ${error.message}` +
            (leftBehind
              ? `. The half-created request could not be removed (${leftBehind}) — ` +
                `recall it from the Approvals page before trying again.`
              : ""),
        };
      }
    }
  }

  // Log history
  await addHistory(requestId, "CREATED", params.userId, `Workflow started: ${params.title}`);
  await addHistory(
    requestId,
    "STEP_ACTIVATED",
    null,
    `Step 1: ${(steps[0] as WorkflowStep).group.name} — ${(steps[0] as WorkflowStep).signatureLabel}`
  );

  // Notify step 1 group members
  await notifyApprovalGroupMembers({
    tenantId: params.tenantId,
    groupIds: [(steps[0] as WorkflowStep).groupId],
    title: "Approval Required",
    message: `${params.userFullName} requests approval: "${params.title}"`,
    link: "/approvals",
    refId: requestId,
    actorId: params.userId,
  });

  await logAudit({
    tenantId: params.tenantId,
    userId: params.userId,
    action: `${params.entityType}.approval.requested`,
    entityType: params.entityType,
    entityId: params.entityId,
    details: { title: params.title },
  });

  return { success: true, requestId, pendingApproval: true, message: `Approval workflow started` };
}

/** Process a decision on a specific approval decision ID */
export async function processDecision({
  decisionId,
  tenantId,
  userId,
  userFullName,
  status,
  comment,
}: {
  decisionId: string;
  tenantId: string;
  userId: string;
  userFullName: string;
  status: "APPROVED" | "REJECTED";
  comment?: string;
}) {
  const db = getServiceClient();
  const now = new Date().toISOString();

  // Get the decision with its request, and the order of the step it sits on
  const { data: decision } = await db
    .from("approval_decisions")
    .select(
      "*, request:approval_requests!approval_decisions_requestId_fkey(*), step:approval_workflow_steps!approval_decisions_stepId_fkey(stepOrder)"
    )
    .eq("id", decisionId)
    .single();

  if (!decision) return { error: "Decision not found" };
  // Defense in depth: refuse cross-tenant decisions explicitly. The group
  // membership check below would also block this in practice (a user from
  // tenant A is never a member of a tenant B group), but relying on that
  // side effect is fragile — tenant scoping should be enforced directly.
  // Return the same "not found" message so we don't leak existence.
  if (decision.request?.tenantId !== tenantId) return { error: "Decision not found" };
  if (decision.status !== "PENDING") return { error: "This step has already been decided" };
  const stale = staleSeatRefusal(decision);
  if (stale) return { error: stale };

  // Verify user is in the approval group
  const { data: membership } = await db
    .from("approval_group_members")
    .select("id")
    .eq("groupId", decision.groupId)
    .eq("userId", userId)
    .single();

  if (!membership) return { error: "You are not a member of this approval group" };

  const request = decision.request;
  const requestId = decision.requestId;

  // Self-approval, if the tenant has turned it off. Checked after membership
  // so the more fundamental refusal wins, and before the compare-and-swap so a
  // refused attempt does not consume a seat. See lib/self-approval.ts — the
  // direct ECO status path needs the same check, and misses it if this one is
  // ever moved into the engine's internals.
  if (request.requestedById === userId && (await blocksSelfApproval(db, tenantId))) {
    return { error: selfApprovalRefusal() };
  }

  // One vote per person per step. ALL and MAJORITY steps now hold one row
  // per group member, and any member can claim any pending row — so without
  // this, one approver could take two seats and satisfy a step alone, which
  // is the exact thing those modes exist to prevent.
  const { data: alreadyDecided } = await db
    .from("approval_decisions")
    .select("id")
    .eq("requestId", requestId)
    .eq("stepId", decision.stepId)
    .eq("deciderId", userId)
    .maybeSingle();
  if (alreadyDecided) {
    return { error: "You have already recorded a decision on this step" };
  }

  // Atomic claim: compare-and-swap on `status = 'PENDING'`. Postgres
  // serializes UPDATEs on the same row, so if two ANY-mode approvers
  // click simultaneously the second one's UPDATE matches zero rows and
  // we bail out cleanly. This is the pessimistic gate that prevents
  // double-counting in ALL/MAJORITY mode and double-side-effects in
  // ANY mode.
  const { data: claimed } = await db
    .from("approval_decisions")
    .update({
      status,
      deciderId: userId,
      comment: comment || null,
      decidedAt: now,
    })
    .eq("id", decisionId)
    .eq("status", "PENDING")
    .select("id")
    .maybeSingle();

  if (!claimed) return { error: "This step has already been decided" };

  // The decider just handled this request — clear any still-unread
  // "Approval Required" notification for them so it doesn't nag after
  // the fact.
  await markNotificationsReadByRef({ tenantId, userId, refId: requestId });

  // History `details` is the "what" only — the UI renders the actor's
  // name separately from `user.fullName`, so prefixing it here would
  // double it up in the timeline.
  void userFullName;
  await addHistory(
    requestId,
    status,
    userId,
    `${decision.signatureLabel || "Approved"} — ${status}${comment ? ` — "${comment}"` : ""}`
  );

  // Now evaluate the step based on approvalMode
  const stepId = decision.stepId;
  const approvalMode = decision.approvalMode || "ANY";

  // Get all decisions for this same step
  const { data: stepDecisions } = await db
    .from("approval_decisions")
    .select("*")
    .eq("requestId", requestId)
    .eq("stepId", stepId);

  const allStepDecisions = stepDecisions || [];
  let stepResolved = false;
  let stepApproved = false;

  if (status === "REJECTED") {
    // Any rejection rejects the step immediately
    stepResolved = true;
    stepApproved = false;
  } else if (approvalMode === "ANY") {
    // One approval is enough
    stepResolved = true;
    stepApproved = true;
  } else if (approvalMode === "ALL" || approvalMode === "MAJORITY") {
    // Both count distinct approvers against the seats this step was given
    // when the workflow started — one per group member. Counting against
    // *current* group membership instead would move the goalposts under a
    // request already in flight: adding a member mid-approval would make a
    // finished ALL step unfinished again.
    //
    // Distinct `deciderId` rather than row count, because the seats are
    // interchangeable and nothing in the schema ties a row to a person. The
    // one-vote-per-person guard above is what makes the two equivalent; this
    // stays defensive in case a row is ever claimed another way.
    const seats = allStepDecisions.length;
    const approvers = new Set(
      allStepDecisions.filter((d) => d.status === "APPROVED" && d.deciderId).map((d) => d.deciderId)
    );
    const needed = approvalMode === "ALL" ? seats : Math.ceil(seats / 2);

    stepApproved = approvers.size >= needed;
    stepResolved = stepApproved;
  }

  if (!stepResolved) {
    // Step not yet resolved — return partial progress
    await logAudit({
      tenantId,
      userId,
      action: `approval.${status.toLowerCase()}`,
      entityType: request.entityType,
      entityId: request.entityId,
      details: {
        title: request.title,
        comment: comment || null,
        signatureLabel: decision.signatureLabel || null,
      },
    });

    return { success: true, requestComplete: false, requestStatus: "PENDING", stepResolved: false };
  }

  const currentStepOrder = request.currentStepOrder || 1;

  if (!stepApproved) {
    // Step rejected — reject the entire request, if it is still at this step.
    const rejected = await settleStep(
      requestId,
      currentStepOrder,
      { status: "REJECTED", updatedAt: now, completedAt: now },
      "Your rejection was recorded, but the request could not be closed"
    );
    if ("error" in rejected) return { error: rejected.error };
    if (!rejected.won) return settledElsewhere(requestId);

    // Nothing on a rejected request is waiting any more — neither this step's
    // other seats nor the steps that will now never start.
    await closeOpenSeats({ requestId }, ["PENDING", "WAITING"]);

    await addHistory(
      requestId,
      "REJECTED",
      userId,
      `Request rejected at step: ${decision.signatureLabel}`
    );

    // Notify requester
    await notify({
      tenantId,
      userIds: [request.requestedById],
      title: "Approval Rejected",
      message: `Your request "${request.title}" was rejected${comment ? `: "${comment}"` : ""}`,
      type: "approval",
      link: "/approvals",
      refId: requestId,
      actorId: userId,
    });

    // Execute rejection side effects
    const rejectionEffect = await handleRequestCompletion(request, "REJECTED", tenantId, userId);

    await logAudit({
      tenantId,
      userId,
      action: `approval.rejected`,
      entityType: request.entityType,
      entityId: request.entityId,
      details: {
        title: request.title,
        comment: comment || null,
        effectNotApplied: rejectionEffect,
      },
    });

    return {
      success: true,
      requestComplete: true,
      requestStatus: "REJECTED",
      warning: rejectionEffect ?? undefined,
    };
  }

  // Step approved — check if there's a next step
  const { data: allDecisions } = await db
    .from("approval_decisions")
    .select("*, step:approval_workflow_steps!approval_decisions_stepId_fkey(stepOrder)")
    .eq("requestId", requestId)
    .order("createdAt");

  const nextStepDecisions = (allDecisions || []).filter((d) => {
    const step = d.step as unknown as { stepOrder: number } | null;
    return step && step.stepOrder === currentStepOrder + 1;
  });

  if (nextStepDecisions.length > 0) {
    // Advance to next step
    const nextStep = nextStepDecisions[0];
    const nextStepData = nextStep.step as unknown as { stepOrder: number };

    // Claim the advance before acting on it. Two approvers landing the
    // deciding votes at the same moment both see the step as resolved; only
    // the one whose compare-and-swap moves the cursor activates the next step
    // and notifies its group.
    const advanced = await settleStep(
      requestId,
      currentStepOrder,
      { currentStepOrder: nextStepData.stepOrder, updatedAt: now },
      "Your approval was recorded, but the request could not be moved to the next step"
    );
    if ("error" in advanced) return { error: advanced.error };
    if (!advanced.won) return settledElsewhere(requestId);

    // This step is done. Its remaining seats would otherwise sit PENDING in
    // someone's inbox, and approving one used to complete the whole request.
    await closeOpenSeats({ requestId, stepId }, ["PENDING"]);

    // Activate next step's decisions. The deadline is already set on the
    // decision row when the workflow was started, so we only need to flip
    // the status from BLOCKED to PENDING.
    for (const nd of nextStepDecisions) {
      // A seat left WAITING is a seat nobody can act on. In ALL or MAJORITY
      // mode that is enough to stall the step permanently, since the count it
      // needs can never be reached.
      const activateFailed = await applied(
        db.from("approval_decisions").update({ status: "PENDING" }).eq("id", nd.id),
        "Your approval was recorded, but the next step could not be activated"
      );
      if (activateFailed) return { error: activateFailed };
    }

    // Look up the step's deadline
    const { data: nextStepFull } = await db
      .from("approval_workflow_steps")
      .select("*, group:approval_groups!approval_workflow_steps_groupId_fkey(id, name)")
      .eq("id", nextStep.stepId)
      .single();

    if (nextStepFull?.deadlineHours) {
      const deadlineAt = new Date(Date.now() + nextStepFull.deadlineHours * 3600000).toISOString();
      for (const nd of nextStepDecisions) {
        // The step is already active by this point, so a missing deadline is
        // a lesser fault than a missing activation — but it is the whole of
        // what the reminder job reads, so a silent miss means a step that is
        // never chased.
        const deadlineFailed = await applied(
          db.from("approval_decisions").update({ deadlineAt }).eq("id", nd.id),
          "The next step was activated, but its deadline could not be set"
        );
        if (deadlineFailed) return { error: deadlineFailed };
      }
    }

    await addHistory(
      requestId,
      "STEP_ACTIVATED",
      null,
      `Step ${nextStepData.stepOrder}: ${nextStepFull?.group?.name || "Unknown"} — ${nextStepFull?.signatureLabel || "Approved"}`
    );

    // Notify next step's group
    if (nextStepFull) {
      await notifyApprovalGroupMembers({
        tenantId,
        groupIds: [nextStepFull.groupId],
        title: "Approval Required",
        message: `Step ${nextStepData.stepOrder} now needs your approval: "${request.title}"`,
        link: "/approvals",
        refId: requestId,
        actorId: userId,
      });
    }

    await logAudit({
      tenantId,
      userId,
      action: `approval.step.approved`,
      entityType: request.entityType,
      entityId: request.entityId,
      details: {
        title: request.title,
        step: currentStepOrder,
        signatureLabel: decision.signatureLabel,
      },
    });

    return {
      success: true,
      requestComplete: false,
      requestStatus: "PENDING",
      stepResolved: true,
      nextStep: nextStepData.stepOrder,
    };
  }

  // No more steps — workflow complete, request approved
  const completed = await settleStep(
    requestId,
    currentStepOrder,
    { status: "APPROVED", updatedAt: now, completedAt: now },
    "Your approval was recorded, but the request could not be completed"
  );
  // Returned before the side effects below, deliberately. Releasing the file
  // or the ECO while the request that authorises it is still PENDING is the
  // worse of the two half-states — it is the one that changes what people
  // build from. And when the compare-and-swap matched nothing, somebody else
  // already completed (or recalled) the request: applying the effects again
  // is exactly what it exists to stop.
  if ("error" in completed) return { error: completed.error };
  if (!completed.won) return settledElsewhere(requestId);

  await closeOpenSeats({ requestId }, ["PENDING", "WAITING"]);

  await addHistory(requestId, "COMPLETED", userId, "All approval steps completed — approved");

  // Notify requester
  await notify({
    tenantId,
    userIds: [request.requestedById],
    title: "Approval Complete",
    message: `Your request "${request.title}" has been fully approved`,
    type: "approval",
    link: "/approvals",
    refId: requestId,
    actorId: userId,
  });

  // Execute approval side effects
  const approvalEffect = await handleRequestCompletion(request, "APPROVED", tenantId, userId);

  await logAudit({
    tenantId,
    userId,
    action: `approval.completed`,
    entityType: request.entityType,
    entityId: request.entityId,
    details: {
      title: request.title,
      signatureLabel: decision.signatureLabel,
      effectNotApplied: approvalEffect,
    },
  });

  return {
    success: true,
    requestComplete: true,
    requestStatus: "APPROVED",
    warning: approvalEffect ?? undefined,
  };
}

/** Recall a pending approval request (by the requester) */
export async function recallRequest({
  requestId,
  tenantId,
  userId,
  userFullName,
}: {
  requestId: string;
  tenantId: string;
  userId: string;
  userFullName: string;
}) {
  const db = getServiceClient();
  const now = new Date().toISOString();

  const { data: request } = await db
    .from("approval_requests")
    .select("*")
    .eq("id", requestId)
    .eq("tenantId", tenantId)
    .single();

  if (!request) return { error: "Request not found" };
  if (request.requestedById !== userId) return { error: "Only the requester can recall" };
  if (request.status !== "PENDING") return { error: "Can only recall pending requests" };

  const recallFailed = await applied(
    db
      .from("approval_requests")
      .update({ status: "RECALLED", updatedAt: now, completedAt: now })
      .eq("id", requestId),
    "The request could not be recalled"
  );
  if (recallFailed) return { error: recallFailed };

  // Reset all pending/waiting decisions
  const clearFailed = await applied(
    db
      .from("approval_decisions")
      .update({ status: "RECALLED" })
      .eq("requestId", requestId)
      .in("status", ["PENDING", "WAITING"]),
    "The request was recalled, but its outstanding approvals are still open"
  );
  if (clearFailed) return { error: clearFailed };

  void userFullName; // UI renders actor from user.fullName — don't double it
  await addHistory(requestId, "RECALLED", userId, `Request recalled`);

  return { success: true };
}

/** Reject with rework — sends request back to requester for changes, then resubmit */
export async function rejectForRework({
  decisionId,
  tenantId,
  userId,
  userFullName,
  comment,
}: {
  decisionId: string;
  tenantId: string;
  userId: string;
  userFullName: string;
  comment: string;
}) {
  const db = getServiceClient();
  const now = new Date().toISOString();

  const { data: decision } = await db
    .from("approval_decisions")
    .select(
      "*, request:approval_requests!approval_decisions_requestId_fkey(*), step:approval_workflow_steps!approval_decisions_stepId_fkey(stepOrder)"
    )
    .eq("id", decisionId)
    .single();

  if (!decision) return { error: "Decision not found" };
  // Defense in depth — see processDecision for the rationale.
  if (decision.request?.tenantId !== tenantId) return { error: "Decision not found" };
  if (decision.status !== "PENDING") return { error: "Step already decided" };
  // A leftover seat must not send a finished request back for rework either:
  // resubmitting it would reopen an approved request and apply it again.
  const stale = staleSeatRefusal(decision);
  if (stale) return { error: stale };

  // Verify membership
  const { data: membership } = await db
    .from("approval_group_members")
    .select("id")
    .eq("groupId", decision.groupId)
    .eq("userId", userId)
    .single();
  if (!membership) return { error: "Not in approval group" };

  const request = decision.request;

  // Rework is a decision on someone else's request too. Sending your own
  // request back to yourself is not separation of duties, so it is refused on
  // the same terms as an approval.
  if (request.requestedById === userId && (await blocksSelfApproval(db, tenantId))) {
    return { error: selfApprovalRefusal("decide") };
  }

  // Mark decision as rework
  const markFailed = await applied(
    db
      .from("approval_decisions")
      .update({
        status: "REWORK",
        deciderId: userId,
        comment,
        decidedAt: now,
      })
      .eq("id", decisionId),
    "The rework request could not be recorded"
  );
  if (markFailed) return { error: markFailed };

  // Clear the decider's own "Approval Required" notification now that
  // they've acted on this request.
  await markNotificationsReadByRef({ tenantId, userId, refId: request.id });

  // Set request to REWORK status
  const statusFailed = await applied(
    db.from("approval_requests").update({ status: "REWORK", updatedAt: now }).eq("id", request.id),
    "Rework was recorded on the step, but the request is still marked pending"
  );
  if (statusFailed) return { error: statusFailed };

  await addHistory(request.id, "REWORK_REQUESTED", userId, `Rework requested: "${comment}"`);

  // Notify the requester
  await notify({
    tenantId,
    userIds: [request.requestedById],
    title: "Rework Requested",
    message: `${userFullName} requested changes on "${request.title}": "${comment}"`,
    type: "approval",
    link: "/approvals",
    refId: request.id,
    actorId: userId,
  });

  return { success: true };
}

/** Resubmit after rework — resets the workflow back to step 1 */
export async function resubmitAfterRework({
  requestId,
  tenantId,
  userId,
  userFullName,
}: {
  requestId: string;
  tenantId: string;
  userId: string;
  userFullName: string;
}) {
  const db = getServiceClient();
  const now = new Date().toISOString();

  const { data: request } = await db
    .from("approval_requests")
    .select("*")
    .eq("id", requestId)
    .eq("tenantId", tenantId)
    .single();

  if (!request) return { error: "Request not found" };
  if (request.requestedById !== userId) return { error: "Only the requester can resubmit" };
  if (request.status !== "REWORK") return { error: "Request must be in rework status" };

  // The requester acted on the rework notification — clear it.
  await markNotificationsReadByRef({ tenantId, userId, refId: requestId });

  // Reset all decisions — step 1 to PENDING, rest to WAITING
  const { data: decisions } = await db
    .from("approval_decisions")
    .select(
      "*, step:approval_workflow_steps!approval_decisions_stepId_fkey(stepOrder, deadlineHours, groupId)"
    )
    .eq("requestId", requestId);

  for (const d of decisions || []) {
    const step = d.step as unknown as {
      stepOrder: number;
      deadlineHours: number | null;
      groupId: string;
    };
    const deadlineAt =
      step.stepOrder === 1 && step.deadlineHours
        ? new Date(Date.now() + step.deadlineHours * 3600000).toISOString()
        : null;

    // A seat that keeps its old decider and REWORK status is a seat the
    // resubmitted request can never collect again.
    const resetFailed = await applied(
      db
        .from("approval_decisions")
        .update({
          status: step.stepOrder === 1 ? "PENDING" : "WAITING",
          deciderId: null,
          comment: null,
          decidedAt: null,
          deadlineAt,
        })
        .eq("id", d.id),
      "The request could not be reset for resubmission"
    );
    if (resetFailed) return { error: resetFailed };
  }

  const resubmitFailed = await applied(
    db
      .from("approval_requests")
      .update({
        status: "PENDING",
        currentStepOrder: 1,
        updatedAt: now,
        completedAt: null,
      })
      .eq("id", requestId),
    "The approval steps were reset, but the request is still marked as rework"
  );
  if (resubmitFailed) return { error: resubmitFailed };

  void userFullName;
  await addHistory(requestId, "RESUBMITTED", userId, `Resubmitted after rework`);

  // Notify step 1 group
  const step1Decisions = (decisions || []).filter((d) => {
    const step = d.step as unknown as { stepOrder: number };
    return step.stepOrder === 1;
  });
  if (step1Decisions.length > 0) {
    const step = step1Decisions[0].step as unknown as { groupId: string };
    await notifyApprovalGroupMembers({
      tenantId,
      groupIds: [step.groupId],
      title: "Approval Re-Requested",
      message: `${userFullName} resubmitted "${request.title}" after rework`,
      link: "/approvals",
      refId: requestId,
      actorId: userId,
    });
  }

  return { success: true };
}

/** Handle side effects when a request completes (approved/rejected) */
/**
 * Apply what the decision actually decides — the file transition, or the ECO
 * status.
 *
 * Returns null when everything landed, or a message when it did not. The
 * caller surfaces that as a `warning` rather than an error, because by this
 * point the approval itself is genuinely complete and telling the approver
 * their approval failed would be false. What is not complete is the effect,
 * and that is worth saying out loud: an approved request whose file never
 * moved looks, from every screen, exactly like one that did.
 */
async function handleRequestCompletion(
  request: { entityType: string; entityId: string; transitionId: string | null },
  status: "APPROVED" | "REJECTED",
  tenantId: string,
  userId: string
): Promise<string | null> {
  const db = getServiceClient();
  const now = new Date().toISOString();
  let revisionNote: string | null = null;

  if (status === "APPROVED" && request.entityType === "file" && request.transitionId) {
    const { data: transition } = await db
      .from("lifecycle_transitions")
      .select(
        "*, toState:lifecycle_states!lifecycle_transitions_toStateId_fkey(name), fromState:lifecycle_states!lifecycle_transitions_fromStateId_fkey(name)"
      )
      .eq("id", request.transitionId)
      .single();

    if (transition) {
      const updateData: Record<string, unknown> = {
        lifecycleState: transition.toState.name,
        updatedAt: now,
      };

      // Pull the file up-front so we have name + createdById for the
      // transition notification below, revision for the optional revision
      // bump on Released→WIP — and the state it is in *now*, which is not
      // necessarily the state it was in when approval was requested.
      const { data: file } = await db
        .from("files")
        .select(
          "name, revision, createdById, lifecycleState, isCheckedOut, deletedAt, checkedOutBy:tenant_users!files_checkedOutById_fkey(fullName)"
        )
        .eq("id", request.entityId)
        .eq("tenantId", tenantId)
        .maybeSingle();

      // Approval can take days, and nothing stops the file moving meanwhile.
      // The transition route refuses a checked-out file and a file not in the
      // transition's from-state; this path applied it regardless. Releasing a
      // checked-out file froze it with the lock still held, which nobody could
      // then check in. The approval stands; the move does not.
      const blocked = fileTransitionBlocker(file, transition.fromState.name);
      if (!file || blocked) {
        return `The request was approved, but the file was not moved to ${transition.toState.name}: ${blocked}`;
      }

      if (transition.toState.name === "Released") updateData.isFrozen = true;
      if (transition.fromState.name === "Released" && transition.toState.name === "WIP") {
        // This is the second path to reopening a released file, and it had
        // been left on the arithmetic `src/lib/revision.ts` exists to
        // replace: `charCodeAt(0) + 1` turns Z into "[" and R2 into "S",
        // writing a wrong value into the field a release is identified by.
        // The direct route (files/[fileId]/transition) was fixed; this one,
        // reached when the same transition requires approval, was not.
        //
        // It cannot refuse the way the route does — the approval has already
        // happened and there is nothing left to decline. So it leaves the
        // revision alone and says so, which is recoverable by hand. Guessing
        // is not.
        if (file?.revision) {
          const next = nextRevision(file.revision);
          if (next) {
            updateData.revision = next.next;
          } else {
            revisionNote =
              `The file was reopened but its revision was left at "${file.revision}" — ` +
              `that is not a revision this can sequence. Set the next revision by hand.`;
          }
        }
        updateData.isFrozen = false;
      }
      if (transition.toState.name === "Obsolete") updateData.isFrozen = true;

      // Conditional on the same three facts just checked, so a check-out or
      // a direct transition landing between the read and this write is not
      // overwritten.
      const { data: moved, error: moveError } = await db
        .from("files")
        .update(updateData)
        .eq("id", request.entityId)
        .eq("tenantId", tenantId)
        .eq("lifecycleState", transition.fromState.name)
        .eq("isCheckedOut", false)
        .is("deletedAt", null)
        .select("id")
        .maybeSingle();
      if (moveError) {
        return `The request was approved, but the file did not move to ${transition.toState.name}: ${moveError.message}`;
      }
      if (!moved) {
        return (
          `The request was approved, but ${file.name} changed while the approval was being ` +
          `applied, so it was not moved to ${transition.toState.name}. Check the file, then ` +
          `request the transition again.`
        );
      }

      if (file) {
        // Use the actor's display name from the completion context — the
        // decider — since they're the one who pushed the state forward.
        const { data: actor } = await db
          .from("tenant_users")
          .select("fullName")
          .eq("id", userId)
          .single();
        await notifyFileTransition({
          tenantId,
          fileId: request.entityId,
          fileName: file.name,
          toStateName: transition.toState.name,
          actorId: userId,
          actorFullName: actor?.fullName || "A reviewer",
          createdById: file.createdById ?? null,
        });
      }

      await logAudit({
        tenantId,
        userId,
        action: "file.transition.approved",
        entityType: "file",
        entityId: request.entityId,
        details: { newState: transition.toState.name, transition: transition.name },
      });
    }
  }

  if (request.entityType === "eco") {
    const outcome = status.toLowerCase();
    const { data: eco, error: readError } = await db
      .from("ecos")
      .select("ecoNumber, status, deletedAt")
      .eq("id", request.entityId)
      .eq("tenantId", tenantId)
      .maybeSingle();
    if (readError) {
      return `The request was ${outcome}, but the ECO could not be read to apply it: ${readError.message}`;
    }
    if (!eco || eco.deletedAt) {
      return `The request was ${outcome}, but the ECO no longer exists, so no status was changed.`;
    }

    // Only an ECO still waiting on this approval takes its outcome. Anything
    // else means the ECO moved on without it, and writing the outcome anyway
    // is how a late rejection turned an implemented ECO back into REJECTED.
    if (!ecoAwaitsApproval(eco.status)) {
      return (
        `The request was ${outcome}, but ${eco.ecoNumber} is now ` +
        `${ECO_STATUS_LABELS[eco.status] ?? eco.status}, so its status was left as it is.`
      );
    }

    const { data: updated, error: ecoError } = await db
      .from("ecos")
      .update({ status: status === "APPROVED" ? "APPROVED" : "REJECTED", updatedAt: now })
      .eq("id", request.entityId)
      .eq("tenantId", tenantId)
      .in("status", [...ECO_STATUSES_AWAITING_APPROVAL])
      .select("id")
      .maybeSingle();
    if (ecoError) {
      return `The request was ${outcome}, but the ECO's status did not change: ${ecoError.message}`;
    }
    if (!updated) {
      return (
        `The request was ${outcome}, but ${eco.ecoNumber} changed status while the approval ` +
        `was being applied, so its status was left as it is.`
      );
    }
  }

  return revisionNote;
}

/**
 * Why an approved file transition cannot be applied to the file as it stands,
 * or null when it can. Mirrors the refusals in `files/[fileId]/transition`.
 */
function fileTransitionBlocker(
  file: {
    name: string;
    lifecycleState: string;
    isCheckedOut: boolean;
    deletedAt: string | null;
    checkedOutBy?: { fullName: string | null } | { fullName: string | null }[] | null;
  } | null,
  fromStateName: string
): string | null {
  if (!file) return "the file no longer exists.";
  if (file.deletedAt) return `${file.name} was deleted while awaiting approval.`;
  if (file.isCheckedOut) {
    const holder = Array.isArray(file.checkedOutBy) ? file.checkedOutBy[0] : file.checkedOutBy;
    return (
      `${file.name} is checked out${holder?.fullName ? ` by ${holder.fullName}` : ""}. ` +
      `Once it is checked in, request the transition again.`
    );
  }
  if (file.lifecycleState !== fromStateName) {
    return (
      `${file.name} changed state to ${file.lifecycleState} while awaiting approval, ` +
      `and this transition starts from ${fromStateName}.`
    );
  }
  return null;
}

/**
 * Why a PENDING seat can no longer be decided, or null when it can.
 *
 * A seat's own status is not enough. A MAJORITY step resolves before every
 * seat has voted, and those seats used to stay PENDING: approving one after
 * step 2 had started was evaluated as the last step and completed the request
 * with step 2 never decided, and rejecting one after completion — even after
 * the ECO was implemented — rejected the request and wrote REJECTED onto the
 * ECO. Resolved steps now close their seats (`closeOpenSeats`), but rows left
 * open before that change still exist, and a race can still produce one.
 */
function staleSeatRefusal(decision: {
  step?: { stepOrder: number } | null;
  request: { status: string; currentStepOrder: number | null };
}): string | null {
  const { request } = decision;
  if (request.status !== "PENDING") {
    return request.status === "REWORK"
      ? "This request has been sent back for rework. It can be decided again once it is resubmitted."
      : `This request is already ${request.status.toLowerCase()} and no longer needs a decision.`;
  }
  const currentStep = request.currentStepOrder || 1;
  const seatStep = decision.step?.stepOrder;
  if (seatStep === undefined) {
    return (
      "This approval's workflow step has been removed, so it cannot be decided. " +
      "Ask the requester to recall the request and submit it again."
    );
  }
  if (seatStep !== currentStep) {
    return (
      `This approval belongs to step ${seatStep}, but the request is at step ` +
      `${currentStep}, so it no longer needs a decision.`
    );
  }
  return null;
}

/**
 * Resolve the step a request is at: approve, reject, or advance it.
 *
 * A compare-and-swap on the request still being PENDING at that step. Two
 * deciding votes landing together both see the step as resolved, and a recall
 * can land between a claim and its resolution; whichever write matches the
 * row wins, and `won: false` tells the loser to stop before any side effect.
 */
async function settleStep(
  requestId: string,
  stepOrder: number,
  changes: Record<string, unknown>,
  what: string
): Promise<{ error: string } | { won: boolean }> {
  const db = getServiceClient();
  const { data, error } = await db
    .from("approval_requests")
    .update(changes)
    .eq("id", requestId)
    .eq("status", "PENDING")
    .eq("currentStepOrder", stepOrder)
    .select("id")
    .maybeSingle();
  if (error) return { error: `${what}: ${error.message}` };
  return { won: !!data };
}

/**
 * The answer for a decision whose vote landed but whose step had already been
 * resolved by the time it tried to resolve it. The vote stands on its seat; it
 * simply changed nothing.
 */
async function settledElsewhere(requestId: string): Promise<{
  success: true;
  requestComplete: boolean;
  requestStatus: string;
  stepResolved: boolean;
  warning: string;
  error?: undefined;
}> {
  const db = getServiceClient();
  const { data } = await db
    .from("approval_requests")
    .select("status")
    .eq("id", requestId)
    .maybeSingle();
  const requestStatus: string = data?.status ?? "PENDING";
  return {
    success: true,
    requestComplete: requestStatus !== "PENDING",
    requestStatus,
    stepResolved: true,
    warning:
      "Your decision was recorded, but this step had already been settled by another " +
      "decision, so it changed nothing.",
  };
}

/**
 * Close the seats a resolved step, or a finished request, no longer needs.
 *
 * Without this a MAJORITY step that resolved at two of three left the third
 * seat PENDING — in that approver's inbox, in the badge count, in the overdue
 * reminder sweep (all of which read `status = 'PENDING'`) and, worst, still
 * decidable. See `staleSeatRefusal` for what deciding one did.
 *
 * `NOT_NEEDED` rather than recall's `RECALLED`: nobody withdrew anything, the
 * step just stopped waiting for this vote. The column is TEXT with no CHECK.
 *
 * Logged rather than returned. By the time this runs the request has already
 * moved, and failing here would skip activating the next step or applying the
 * outcome, which is the worse half-state; a seat left open is refused by
 * `staleSeatRefusal` regardless.
 */
async function closeOpenSeats(scope: { requestId: string; stepId?: string }, statuses: string[]) {
  const db = getServiceClient();
  let seats = db
    .from("approval_decisions")
    .update({ status: "NOT_NEEDED" })
    .eq("requestId", scope.requestId);
  if (scope.stepId) seats = seats.eq("stepId", scope.stepId);
  const { error } = await seats.in("status", statuses);
  if (error) {
    console.error(
      `[approvals] failed to close open seats on request ${scope.requestId}:`,
      error.message
    );
  }
}

/**
 * Remove a request that failed partway through creation, seats first.
 * Returns null when it is gone, or the reason it is not.
 */
async function discardRequest(requestId: string): Promise<string | null> {
  const db = getServiceClient();
  const { error: seatsError } = await db
    .from("approval_decisions")
    .delete()
    .eq("requestId", requestId);
  if (seatsError) return seatsError.message;
  const { error: requestError } = await db.from("approval_requests").delete().eq("id", requestId);
  return requestError ? requestError.message : null;
}

/**
 * Apply one write, and describe the failure rather than discarding it.
 *
 * Returns null when the write landed, and a message naming what did not
 * happen when it did not. Callers turn that into their own `{ error }`.
 *
 * A rejected UPDATE is the quietest of the three write failures: nothing is
 * missing afterwards, the row still reads fine, and the only symptom is that
 * it holds the value it held before. In this file that means a request that
 * reports approved and stays PENDING, or a step that reports activated while
 * every seat on it is still WAITING and nobody can act.
 */
async function applied(
  write: PromiseLike<{ error: { message: string } | null }>,
  what: string
): Promise<string | null> {
  const { error } = await write;
  return error ? `${what}: ${error.message}` : null;
}

async function addHistory(
  requestId: string,
  event: string,
  userId: string | null,
  details: string
) {
  const db = getServiceClient();
  const { error } = await db.from("approval_history").insert({
    id: uuid(),
    requestId,
    event,
    userId,
    details,
    createdAt: new Date().toISOString(),
  });

  // Logged rather than thrown, on the same reasoning as logAudit: every
  // caller runs this *after* the decision it describes, so throwing would
  // fail a transition that already happened. A gap in the timeline is bad;
  // an approval that reports failure after approving is worse.
  if (error) {
    console.error(`[approvals] failed to record ${event} on request ${requestId}:`, error.message);
  }
}

/** Get the approval history timeline for a request */
export async function getRequestTimeline(requestId: string) {
  const db = getServiceClient();
  const { data } = await db
    .from("approval_history")
    .select("*, user:tenant_users!approval_history_userId_fkey(fullName)")
    .eq("requestId", requestId)
    .order("createdAt");

  return data || [];
}

/** Find the workflow assigned to a transition or ECO trigger */
export async function findWorkflowForTrigger({
  tenantId,
  transitionId,
  ecoTrigger,
}: {
  tenantId: string;
  transitionId?: string;
  ecoTrigger?: string;
}) {
  const db = getServiceClient();

  let query = db
    .from("approval_workflow_assignments")
    .select(
      "*, workflow:approval_workflows!approval_workflow_assignments_workflowId_fkey(id, name, isActive)"
    )
    .eq("tenantId", tenantId);

  if (transitionId) {
    query = query.eq("transitionId", transitionId);
  } else if (ecoTrigger) {
    query = query.eq("ecoTrigger", ecoTrigger);
  } else {
    return null;
  }

  const { data } = await query.limit(1);
  if (!data || data.length === 0) return null;

  const assignment = data[0];
  const workflow = assignment.workflow as unknown as {
    id: string;
    name: string;
    isActive: boolean;
  };
  if (!workflow.isActive) return null;

  return workflow;
}
