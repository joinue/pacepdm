import { getServiceClient } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import {
  notify,
  notifyApprovalGroupMembers,
  notifyFileTransition,
  markNotificationsReadByRef,
} from "@/lib/notifications";
import { v4 as uuid } from "uuid";

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

  if (insertErr && insertErr.code === "23505" && params.clientRequestKey) {
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

  // Create decisions for every step (only step 1 starts active).
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
  for (const step of steps as WorkflowStep[]) {
    const deadlineAt = step.deadlineHours
      ? new Date(Date.now() + step.deadlineHours * 3600000).toISOString()
      : null;
    const isFirst = step.stepOrder === 1;

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

    for (let seat = 0; seat < seats; seat++) {
      await db.from("approval_decisions").insert({
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

  // Get the decision with its request
  const { data: decision } = await db
    .from("approval_decisions")
    .select("*, request:approval_requests!approval_decisions_requestId_fkey(*)")
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

  if (!stepApproved) {
    // Step rejected — reject the entire request
    await db
      .from("approval_requests")
      .update({
        status: "REJECTED",
        updatedAt: now,
        completedAt: now,
      })
      .eq("id", requestId);

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
    await handleRequestCompletion(request, "REJECTED", tenantId, userId);

    await logAudit({
      tenantId,
      userId,
      action: `approval.rejected`,
      entityType: request.entityType,
      entityId: request.entityId,
      details: { title: request.title, comment: comment || null },
    });

    return { success: true, requestComplete: true, requestStatus: "REJECTED" };
  }

  // Step approved — check if there's a next step
  const { data: allDecisions } = await db
    .from("approval_decisions")
    .select("*, step:approval_workflow_steps!approval_decisions_stepId_fkey(stepOrder)")
    .eq("requestId", requestId)
    .order("createdAt");

  const currentStepOrder = request.currentStepOrder || 1;
  const nextStepDecisions = (allDecisions || []).filter((d) => {
    const step = d.step as unknown as { stepOrder: number } | null;
    return step && step.stepOrder === currentStepOrder + 1;
  });

  if (nextStepDecisions.length > 0) {
    // Advance to next step
    const nextStep = nextStepDecisions[0];
    const nextStepData = nextStep.step as unknown as { stepOrder: number };

    // Activate next step's decisions. The deadline is already set on the
    // decision row when the workflow was started, so we only need to flip
    // the status from BLOCKED to PENDING.
    for (const nd of nextStepDecisions) {
      await db.from("approval_decisions").update({ status: "PENDING" }).eq("id", nd.id);
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
        await db.from("approval_decisions").update({ deadlineAt }).eq("id", nd.id);
      }
    }

    await db
      .from("approval_requests")
      .update({
        currentStepOrder: nextStepData.stepOrder,
        updatedAt: now,
      })
      .eq("id", requestId);

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
  await db
    .from("approval_requests")
    .update({
      status: "APPROVED",
      updatedAt: now,
      completedAt: now,
    })
    .eq("id", requestId);

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
  await handleRequestCompletion(request, "APPROVED", tenantId, userId);

  await logAudit({
    tenantId,
    userId,
    action: `approval.completed`,
    entityType: request.entityType,
    entityId: request.entityId,
    details: { title: request.title, signatureLabel: decision.signatureLabel },
  });

  return { success: true, requestComplete: true, requestStatus: "APPROVED" };
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

  await db
    .from("approval_requests")
    .update({ status: "RECALLED", updatedAt: now, completedAt: now })
    .eq("id", requestId);

  // Reset all pending/waiting decisions
  await db
    .from("approval_decisions")
    .update({ status: "RECALLED" })
    .eq("requestId", requestId)
    .in("status", ["PENDING", "WAITING"]);

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
    .select("*, request:approval_requests!approval_decisions_requestId_fkey(*)")
    .eq("id", decisionId)
    .single();

  if (!decision) return { error: "Decision not found" };
  // Defense in depth — see processDecision for the rationale.
  if (decision.request?.tenantId !== tenantId) return { error: "Decision not found" };
  if (decision.status !== "PENDING") return { error: "Step already decided" };

  // Verify membership
  const { data: membership } = await db
    .from("approval_group_members")
    .select("id")
    .eq("groupId", decision.groupId)
    .eq("userId", userId)
    .single();
  if (!membership) return { error: "Not in approval group" };

  const request = decision.request;

  // Mark decision as rework
  await db
    .from("approval_decisions")
    .update({
      status: "REWORK",
      deciderId: userId,
      comment,
      decidedAt: now,
    })
    .eq("id", decisionId);

  // Clear the decider's own "Approval Required" notification now that
  // they've acted on this request.
  await markNotificationsReadByRef({ tenantId, userId, refId: request.id });

  // Set request to REWORK status
  await db
    .from("approval_requests")
    .update({ status: "REWORK", updatedAt: now })
    .eq("id", request.id);

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

    await db
      .from("approval_decisions")
      .update({
        status: step.stepOrder === 1 ? "PENDING" : "WAITING",
        deciderId: null,
        comment: null,
        decidedAt: null,
        deadlineAt,
      })
      .eq("id", d.id);
  }

  await db
    .from("approval_requests")
    .update({
      status: "PENDING",
      currentStepOrder: 1,
      updatedAt: now,
      completedAt: null,
    })
    .eq("id", requestId);

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
async function handleRequestCompletion(
  request: { entityType: string; entityId: string; transitionId: string | null },
  status: "APPROVED" | "REJECTED",
  tenantId: string,
  userId: string
) {
  const db = getServiceClient();
  const now = new Date().toISOString();

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
      // transition notification below, and revision for the optional
      // revision bump on Released→WIP.
      const { data: file } = await db
        .from("files")
        .select("name, revision, createdById")
        .eq("id", request.entityId)
        .single();

      if (transition.toState.name === "Released") updateData.isFrozen = true;
      if (transition.fromState.name === "Released" && transition.toState.name === "WIP") {
        if (file?.revision) {
          updateData.revision = String.fromCharCode(file.revision.charCodeAt(0) + 1);
        }
        updateData.isFrozen = false;
      }
      if (transition.toState.name === "Obsolete") updateData.isFrozen = true;

      await db.from("files").update(updateData).eq("id", request.entityId);

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
    await db
      .from("ecos")
      .update({
        status: status === "APPROVED" ? "APPROVED" : "REJECTED",
        updatedAt: now,
      })
      .eq("id", request.entityId);
  }
}

async function addHistory(
  requestId: string,
  event: string,
  userId: string | null,
  details: string
) {
  const db = getServiceClient();
  await db.from("approval_history").insert({
    id: uuid(),
    requestId,
    event,
    userId,
    details,
    createdAt: new Date().toISOString(),
  });
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
