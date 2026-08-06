import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock setup (vi.hoisted so variables are available in vi.mock factories) ──

const { tableResults, insertCalls, updateCalls, claimResult, insertError, mockFrom } = vi.hoisted(
  () => {
    type QueryResult = { data: unknown; error: unknown };
    /**
     * A table's result may be a fixed value or a function of the filters the
     * query applied. `processDecision` hits `approval_decisions` five times in
     * one call — by id, by (requestId, stepId, deciderId), by (requestId,
     * stepId), and by requestId — and each wants a different answer, so a fixed
     * value per table cannot express the flow.
     */
    type Handler = QueryResult | ((filters: Record<string, unknown>) => QueryResult);

    const tableResults: Record<string, Handler> = {};
    const insertCalls: Array<{ table: string; data: unknown }> = [];
    const updateCalls: Array<{ table: string; data: unknown; filters: Record<string, unknown> }> =
      [];
    /** What the compare-and-swap claim in `processDecision` returns. */
    const claimResult = { current: { data: { id: "dec-1" }, error: null } as QueryResult };
    /** Error returned by the next `approval_requests` insert, for the 23505 race. */
    const insertError = { current: null as { code?: string } | null };

    function makeChain(table: string) {
      const filters: Record<string, unknown> = {};
      const chain: Record<string, (...args: unknown[]) => unknown> = {};

      const resolvable = (): QueryResult => {
        const handler = tableResults[table];
        if (typeof handler === "function") return handler(filters);
        return handler ?? { data: null, error: null };
      };

      for (const m of ["select", "eq", "in", "neq", "is", "order", "limit", "match"] as const) {
        chain[m] = (...args: unknown[]) => {
          if (m === "eq" && args.length === 2) filters[args[0] as string] = args[1];
          return chain;
        };
      }

      chain.single = () => resolvable();
      chain.maybeSingle = () => resolvable();

      chain.insert = (data: unknown) => {
        insertCalls.push({ table, data });
        const error = table === "approval_requests" ? insertError.current : null;
        return Promise.resolve({ data: null, error });
      };

      chain.update = (data: unknown) => {
        const entry = { table, data, filters: { ...filters } };
        updateCalls.push(entry);
        const updateChain: Record<string, (...args: unknown[]) => unknown> = {};
        for (const m of ["eq", "in", "select"] as const) {
          updateChain[m] = (...args: unknown[]) => {
            if (m === "eq" && args.length === 2) entry.filters[args[0] as string] = args[1];
            return updateChain;
          };
        }
        updateChain.maybeSingle = () => claimResult.current;
        updateChain.single = () => claimResult.current;
        updateChain.then = ((resolve: (v: unknown) => void) =>
          resolve({ data: null, error: null })) as unknown as (...args: unknown[]) => unknown;
        return updateChain;
      };

      chain.then = ((resolve: (v: unknown) => void) => resolve(resolvable())) as unknown as (
        ...args: unknown[]
      ) => unknown;

      return chain;
    }

    const mockFrom = (table: string) => makeChain(table);

    return { tableResults, insertCalls, updateCalls, claimResult, insertError, mockFrom };
  }
);

vi.mock("@/lib/db", () => ({
  getServiceClient: () => ({ from: mockFrom }),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/notifications", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
  notifyApprovalGroupMembers: vi.fn().mockResolvedValue(undefined),
  notifyFileTransition: vi.fn().mockResolvedValue(undefined),
  markNotificationsReadByRef: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("uuid", () => ({ v4: () => "mock-uuid" }));

import {
  startWorkflow,
  recallRequest,
  findWorkflowForTrigger,
  processDecision,
  rejectForRework,
  resubmitAfterRework,
  getRequestTimeline,
} from "./approval-engine";
import { logAudit } from "./audit";
import {
  notify,
  notifyApprovalGroupMembers,
  notifyFileTransition,
  markNotificationsReadByRef,
} from "./notifications";

// ── Helpers ─────────────────────────────────────────────────────────────────

function resetMockState() {
  vi.clearAllMocks();
  insertCalls.length = 0;
  updateCalls.length = 0;
  claimResult.current = { data: { id: "dec-1" }, error: null };
  insertError.current = null;
  for (const key of Object.keys(tableResults)) delete tableResults[key];
}

const baseParams = {
  tenantId: "tenant-1",
  userId: "user-1",
  userFullName: "John Doe",
  workflowId: "wf-1",
  type: "FILE_TRANSITION",
  entityType: "file",
  entityId: "file-1",
  transitionId: "trans-1",
  title: "Release bracket.sldprt",
  description: "Moving to Released state",
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe("startWorkflow", () => {
  beforeEach(resetMockState);

  it("returns error when workflow has no steps", async () => {
    tableResults["approval_workflow_steps"] = { data: [], error: null };
    const result = await startWorkflow(baseParams);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Workflow has no steps");
  });

  it("returns error when steps query returns null", async () => {
    tableResults["approval_workflow_steps"] = { data: null, error: null };
    const result = await startWorkflow(baseParams);
    expect(result.success).toBe(false);
  });

  it("creates request and decisions for a single-step workflow", async () => {
    tableResults["approval_workflow_steps"] = {
      data: [
        {
          id: "step-1",
          groupId: "group-1",
          stepOrder: 1,
          approvalMode: "ANY",
          signatureLabel: "Engineering Approval",
          deadlineHours: 48,
          group: { id: "group-1", name: "Engineering" },
        },
      ],
      error: null,
    };

    const result = await startWorkflow(baseParams);

    expect(result.success).toBe(true);
    expect(result.pendingApproval).toBe(true);

    // Should have inserted an approval_request
    const reqInsert = insertCalls.find((c) => c.table === "approval_requests");
    expect(reqInsert).toBeDefined();
    expect(reqInsert!.data).toMatchObject({
      tenantId: "tenant-1",
      type: "FILE_TRANSITION",
      entityType: "file",
      entityId: "file-1",
      status: "PENDING",
      currentStepOrder: 1,
    });

    // Should have inserted a decision for step 1 with PENDING status
    const decInsert = insertCalls.find((c) => c.table === "approval_decisions");
    expect(decInsert).toBeDefined();
    expect(decInsert!.data).toMatchObject({
      groupId: "group-1",
      stepId: "step-1",
      status: "PENDING",
      approvalMode: "ANY",
    });
    // Deadline should be set for step 1 (48 hours)
    expect((decInsert!.data as Record<string, unknown>).deadlineAt).toBeTruthy();
  });

  it("sets step 2+ decisions to WAITING status", async () => {
    tableResults["approval_workflow_steps"] = {
      data: [
        {
          id: "step-1",
          groupId: "group-1",
          stepOrder: 1,
          approvalMode: "ANY",
          signatureLabel: "Design",
          deadlineHours: null,
          group: { id: "group-1", name: "Design Team" },
        },
        {
          id: "step-2",
          groupId: "group-2",
          stepOrder: 2,
          approvalMode: "ALL",
          signatureLabel: "QA",
          deadlineHours: 24,
          group: { id: "group-2", name: "QA Team" },
        },
      ],
      error: null,
    };

    // Step 2 is an ALL step, so it gets one decision row per group member.
    // A single member keeps this test's arithmetic at one row per step.
    tableResults["approval_group_members"] = { data: [{ userId: "qa-1" }], error: null };

    await startWorkflow(baseParams);

    const decisions = insertCalls.filter((c) => c.table === "approval_decisions");
    expect(decisions).toHaveLength(2);

    const step1 = decisions.find((d) => (d.data as Record<string, unknown>).stepId === "step-1");
    const step2 = decisions.find((d) => (d.data as Record<string, unknown>).stepId === "step-2");

    expect((step1!.data as Record<string, unknown>).status).toBe("PENDING");
    expect((step2!.data as Record<string, unknown>).status).toBe("WAITING");
    expect((step2!.data as Record<string, unknown>).deadlineAt).toBeNull();
  });

  it("notifies step 1 approval group members", async () => {
    tableResults["approval_workflow_steps"] = {
      data: [
        {
          id: "step-1",
          groupId: "group-1",
          stepOrder: 1,
          approvalMode: "ANY",
          signatureLabel: "Review",
          deadlineHours: null,
          group: { id: "group-1", name: "Reviewers" },
        },
      ],
      error: null,
    };

    await startWorkflow(baseParams);

    expect(notifyApprovalGroupMembers).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        groupIds: ["group-1"],
        title: "Approval Required",
      })
    );
  });

  it("creates audit log entry", async () => {
    tableResults["approval_workflow_steps"] = {
      data: [
        {
          id: "step-1",
          groupId: "group-1",
          stepOrder: 1,
          approvalMode: "ANY",
          signatureLabel: "OK",
          deadlineHours: null,
          group: { id: "group-1", name: "Team" },
        },
      ],
      error: null,
    };

    await startWorkflow(baseParams);

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        userId: "user-1",
        action: "file.approval.requested",
        entityType: "file",
        entityId: "file-1",
      })
    );
  });

  it("logs CREATED and STEP_ACTIVATED history events", async () => {
    tableResults["approval_workflow_steps"] = {
      data: [
        {
          id: "step-1",
          groupId: "group-1",
          stepOrder: 1,
          approvalMode: "ANY",
          signatureLabel: "Approve",
          deadlineHours: null,
          group: { id: "group-1", name: "Engineers" },
        },
      ],
      error: null,
    };

    await startWorkflow(baseParams);

    const historyInserts = insertCalls.filter((c) => c.table === "approval_history");
    expect(historyInserts.length).toBeGreaterThanOrEqual(2);

    const events = historyInserts.map((h) => (h.data as Record<string, unknown>).event);
    expect(events).toContain("CREATED");
    expect(events).toContain("STEP_ACTIVATED");
  });
});

/**
 * Duplicate suppression. A double-clicked Transition button must not put the
 * same file in front of an approval group twice, and there are three guards
 * for it: the caller's idempotency key, an entity-level check for a request
 * already pending on the same (entity, transition), and the unique index that
 * catches a race between the pre-check and the insert.
 */
describe("startWorkflow — duplicate suppression", () => {
  beforeEach(resetMockState);

  const oneStep = {
    data: [
      {
        id: "step-1",
        groupId: "group-1",
        stepOrder: 1,
        approvalMode: "ANY",
        signatureLabel: "Approve",
        deadlineHours: null,
        group: { id: "group-1", name: "Engineers" },
      },
    ],
    error: null,
  };

  it("returns the existing request when the idempotency key has been seen", async () => {
    tableResults["approval_workflow_steps"] = oneStep;
    tableResults["approval_requests"] = (filters) =>
      filters.clientRequestKey === "key-abc"
        ? { data: { id: "req-existing" }, error: null }
        : { data: null, error: null };

    const result = await startWorkflow({ ...baseParams, clientRequestKey: "key-abc" });

    expect(result).toMatchObject({
      success: true,
      requestId: "req-existing",
      pendingApproval: true,
    });
    // Nothing was created — that is the whole point of the key.
    expect(insertCalls).toHaveLength(0);
  });

  /**
   * Not every caller sends a key, so the entity-level guard has to stand on
   * its own: one PENDING request per (entity, transition).
   */
  it("returns the in-flight request when one is already pending for the entity", async () => {
    tableResults["approval_workflow_steps"] = oneStep;
    tableResults["approval_requests"] = (filters) =>
      filters.entityId === "file-1" && filters.status === "PENDING"
        ? { data: { id: "req-inflight" }, error: null }
        : { data: null, error: null };

    const result = await startWorkflow(baseParams);

    expect(result).toMatchObject({ requestId: "req-inflight", pendingApproval: true });
    expect(insertCalls).toHaveLength(0);
  });

  /**
   * The pre-check and the insert are not atomic. When another caller lands in
   * between, the unique index rejects with 23505 and we adopt their request
   * rather than surfacing a database error to someone who just clicked twice.
   */
  it("adopts the winner's request when the insert loses a 23505 race", async () => {
    tableResults["approval_workflow_steps"] = oneStep;
    let seenPreCheck = false;
    tableResults["approval_requests"] = (filters) => {
      if (filters.clientRequestKey !== "key-abc") return { data: null, error: null };
      // Empty on the pre-check, occupied by the time we re-read after 23505.
      if (!seenPreCheck) {
        seenPreCheck = true;
        return { data: null, error: null };
      }
      return { data: { id: "req-winner" }, error: null };
    };
    insertError.current = { code: "23505" };

    const result = await startWorkflow({ ...baseParams, clientRequestKey: "key-abc" });

    expect(result).toMatchObject({ requestId: "req-winner", pendingApproval: true });
    // No decisions were created for the request that lost.
    expect(insertCalls.filter((c) => c.table === "approval_decisions")).toHaveLength(0);
  });

  it("stores the idempotency key so a later retry can find the request", async () => {
    tableResults["approval_workflow_steps"] = oneStep;
    tableResults["approval_requests"] = { data: null, error: null };
    await startWorkflow({ ...baseParams, clientRequestKey: "key-xyz" });
    const insert = insertCalls.find((c) => c.table === "approval_requests")!;
    expect(insert.data).toMatchObject({ clientRequestKey: "key-xyz" });
  });

  it("stores a null key when the caller sent none", async () => {
    tableResults["approval_workflow_steps"] = oneStep;
    tableResults["approval_requests"] = { data: null, error: null };
    await startWorkflow(baseParams);
    const insert = insertCalls.find((c) => c.table === "approval_requests")!;
    expect((insert.data as Record<string, unknown>).clientRequestKey).toBeNull();
  });
});

describe("recallRequest", () => {
  beforeEach(resetMockState);

  it("returns error when request not found", async () => {
    tableResults["approval_requests"] = { data: null, error: null };
    const result = await recallRequest({
      requestId: "req-1",
      tenantId: "tenant-1",
      userId: "user-1",
      userFullName: "John Doe",
    });
    expect(result.error).toBe("Request not found");
  });

  it("returns error when non-requester tries to recall", async () => {
    tableResults["approval_requests"] = {
      data: { id: "req-1", requestedById: "user-2", status: "PENDING" },
      error: null,
    };
    const result = await recallRequest({
      requestId: "req-1",
      tenantId: "tenant-1",
      userId: "user-1",
      userFullName: "John Doe",
    });
    expect(result.error).toBe("Only the requester can recall");
  });

  it("returns error when request is not pending", async () => {
    tableResults["approval_requests"] = {
      data: { id: "req-1", requestedById: "user-1", status: "APPROVED" },
      error: null,
    };
    const result = await recallRequest({
      requestId: "req-1",
      tenantId: "tenant-1",
      userId: "user-1",
      userFullName: "John Doe",
    });
    expect(result.error).toBe("Can only recall pending requests");
  });

  it("succeeds when requester recalls their pending request", async () => {
    tableResults["approval_requests"] = {
      data: { id: "req-1", requestedById: "user-1", status: "PENDING" },
      error: null,
    };

    const result = await recallRequest({
      requestId: "req-1",
      tenantId: "tenant-1",
      userId: "user-1",
      userFullName: "John Doe",
    });

    expect(result.success).toBe(true);

    // Should update request to RECALLED
    const reqUpdate = updateCalls.find((c) => c.table === "approval_requests");
    expect(reqUpdate).toBeDefined();
    expect(reqUpdate!.data).toMatchObject({ status: "RECALLED" });

    // Should update decisions to RECALLED
    const decUpdate = updateCalls.find((c) => c.table === "approval_decisions");
    expect(decUpdate).toBeDefined();
    expect(decUpdate!.data).toMatchObject({ status: "RECALLED" });

    // Should log history
    const historyInsert = insertCalls.find((c) => c.table === "approval_history");
    expect(historyInsert).toBeDefined();
    expect((historyInsert!.data as Record<string, unknown>).event).toBe("RECALLED");
  });
});

describe("findWorkflowForTrigger", () => {
  beforeEach(resetMockState);

  it("returns null when no transitionId or ecoTrigger provided", async () => {
    const result = await findWorkflowForTrigger({ tenantId: "tenant-1" });
    expect(result).toBeNull();
  });

  it("returns null when no assignment found", async () => {
    tableResults["approval_workflow_assignments"] = { data: [], error: null };
    const result = await findWorkflowForTrigger({ tenantId: "tenant-1", transitionId: "trans-1" });
    expect(result).toBeNull();
  });

  it("returns null when workflow is inactive", async () => {
    tableResults["approval_workflow_assignments"] = {
      data: [{ id: "a-1", workflow: { id: "wf-1", name: "Old", isActive: false } }],
      error: null,
    };
    const result = await findWorkflowForTrigger({ tenantId: "tenant-1", transitionId: "trans-1" });
    expect(result).toBeNull();
  });

  it("returns workflow when active assignment found for transition", async () => {
    tableResults["approval_workflow_assignments"] = {
      data: [{ id: "a-1", workflow: { id: "wf-1", name: "Release Approval", isActive: true } }],
      error: null,
    };
    const result = await findWorkflowForTrigger({ tenantId: "tenant-1", transitionId: "trans-1" });
    expect(result).toEqual({ id: "wf-1", name: "Release Approval", isActive: true });
  });

  it("queries by ecoTrigger when transitionId not provided", async () => {
    tableResults["approval_workflow_assignments"] = {
      data: [{ id: "a-2", workflow: { id: "wf-2", name: "ECO Review", isActive: true } }],
      error: null,
    };
    const result = await findWorkflowForTrigger({ tenantId: "tenant-1", ecoTrigger: "SUBMITTED" });
    expect(result).toEqual({ id: "wf-2", name: "ECO Review", isActive: true });
  });
});

// ── Multi-tenant defense-in-depth guards ──────────────────────────────────
//
// processDecision and rejectForRework take a `tenantId` parameter from the
// caller (the API route uses tenantUser.tenantId). They must verify that the
// fetched decision actually belongs to that tenant before mutating anything.
// Group-membership checks would also block cross-tenant calls in practice,
// but tenant scoping should be enforced explicitly so future refactors don't
// silently drop the only line of defense.

describe("processDecision — tenant guard", () => {
  beforeEach(resetMockState);

  it("returns 'Decision not found' when the decision belongs to another tenant", async () => {
    tableResults["approval_decisions"] = {
      data: {
        id: "dec-1",
        groupId: "group-1",
        stepId: "step-1",
        status: "PENDING",
        approvalMode: "ANY",
        request: {
          id: "req-1",
          tenantId: "tenant-2", // ← belongs to a DIFFERENT tenant
          entityType: "file",
          entityId: "file-1",
          requestedById: "user-99",
          title: "Cross-tenant target",
        },
      },
      error: null,
    };

    const result = await processDecision({
      decisionId: "dec-1",
      tenantId: "tenant-1", // caller is in tenant-1
      userId: "user-1",
      userFullName: "Alice",
      status: "APPROVED",
    });

    expect(result).toEqual({ error: "Decision not found" });

    // Critical: NO updates should have been issued. If the guard fired late,
    // we'd see an update on approval_decisions or approval_requests here.
    expect(updateCalls).toHaveLength(0);
  });
});

describe("rejectForRework — tenant guard", () => {
  beforeEach(resetMockState);

  it("returns 'Decision not found' when the decision belongs to another tenant", async () => {
    tableResults["approval_decisions"] = {
      data: {
        id: "dec-1",
        groupId: "group-1",
        status: "PENDING",
        request: {
          id: "req-1",
          tenantId: "tenant-2",
          requestedById: "user-99",
          title: "Cross-tenant target",
        },
      },
      error: null,
    };

    const result = await rejectForRework({
      decisionId: "dec-1",
      tenantId: "tenant-1",
      userId: "user-1",
      userFullName: "Alice",
      comment: "should never be applied",
    });

    expect(result).toEqual({ error: "Decision not found" });
    expect(updateCalls).toHaveLength(0);
  });
});

/**
 * Multi-approver modes.
 *
 * A decision row records exactly one decider — `processDecision` claims it
 * with a compare-and-swap on `status = 'PENDING'` and stamps a single
 * `deciderId`. So a step needing several approvers needs several rows.
 *
 * With one row per step regardless of mode, ALL deadlocked at two or more
 * members and MAJORITY at three or more: the row was claimed by the first
 * approver, the "everyone approved" test could never see a second decider,
 * and nobody else could act because the row was no longer PENDING. The
 * request sat PENDING with no exit but a recall. Both modes are selectable
 * in Admin → Workflows, so it was reachable configuration rather than a
 * theoretical shape.
 */
describe("startWorkflow — seats per approval mode", () => {
  beforeEach(resetMockState);

  function stepsWithMode(approvalMode: string) {
    tableResults["approval_workflow_steps"] = {
      data: [
        {
          id: "step-1",
          groupId: "group-1",
          stepOrder: 1,
          approvalMode,
          signatureLabel: "Review",
          deadlineHours: null,
          group: { id: "group-1", name: "Reviewers" },
        },
      ],
      error: null,
    };
  }

  it("gives an ANY step one seat regardless of group size", async () => {
    stepsWithMode("ANY");
    tableResults["approval_group_members"] = {
      data: [{ userId: "u1" }, { userId: "u2" }, { userId: "u3" }],
      error: null,
    };

    await startWorkflow(baseParams);

    expect(insertCalls.filter((c) => c.table === "approval_decisions")).toHaveLength(1);
  });

  it("gives an ALL step one seat per group member", async () => {
    stepsWithMode("ALL");
    tableResults["approval_group_members"] = {
      data: [{ userId: "u1" }, { userId: "u2" }, { userId: "u3" }],
      error: null,
    };

    await startWorkflow(baseParams);

    const decisions = insertCalls.filter((c) => c.table === "approval_decisions");
    expect(decisions).toHaveLength(3);
    // All three are live immediately — this is one step, not three.
    for (const d of decisions) {
      expect((d.data as Record<string, unknown>).status).toBe("PENDING");
      expect((d.data as Record<string, unknown>).stepId).toBe("step-1");
    }
  });

  it("gives a MAJORITY step one seat per group member", async () => {
    stepsWithMode("MAJORITY");
    tableResults["approval_group_members"] = {
      data: [{ userId: "u1" }, { userId: "u2" }, { userId: "u3" }],
      error: null,
    };

    await startWorkflow(baseParams);

    expect(insertCalls.filter((c) => c.table === "approval_decisions")).toHaveLength(3);
  });

  it("refuses to start an ALL step whose group is empty", async () => {
    // Better to fail here than to create a request nobody can ever finish,
    // leaving the file or ECO stranded mid-transition.
    stepsWithMode("ALL");
    tableResults["approval_group_members"] = { data: [], error: null };

    const result = await startWorkflow(baseParams);

    expect(result.success).toBe(false);
    expect(result.error).toContain("no members");
    expect(insertCalls.filter((c) => c.table === "approval_decisions")).toHaveLength(0);
  });
});

// ── processDecision ────────────────────────────────────────────────────────
//
// The engine's centre of gravity: it claims a seat, evaluates the step against
// its approval mode, and either advances, rejects, or completes the request.
// Everything below drives that path with a mock that answers each of the five
// `approval_decisions` queries separately — see the Handler type at the top.

interface DecisionScenario {
  approvalMode?: string;
  /** Status of the decision row being acted on. */
  status?: string;
  /** Every seat on the step, as they look *after* the claim lands. */
  stepDecisions?: Array<{ status: string; deciderId: string | null }>;
  /** Every decision on the request, used to find the next step. */
  allDecisions?: Array<{ id: string; stepId: string; step: { stepOrder: number } }>;
  request?: Record<string, unknown>;
  /** False makes the actor a non-member of the approval group. */
  member?: boolean;
  /** True means this actor already voted on this step. */
  alreadyDecided?: boolean;
}

function givenDecision(scenario: DecisionScenario = {}) {
  const request = {
    id: "req-1",
    tenantId: "tenant-1",
    entityType: "file",
    entityId: "file-1",
    transitionId: null,
    requestedById: "user-9",
    title: "Release bracket.sldprt",
    currentStepOrder: 1,
    ...scenario.request,
  };
  const decision = {
    id: "dec-1",
    requestId: "req-1",
    stepId: "step-1",
    groupId: "group-1",
    status: scenario.status ?? "PENDING",
    approvalMode: scenario.approvalMode ?? "ANY",
    signatureLabel: "Engineering Approval",
    request,
  };

  tableResults["approval_decisions"] = (filters) => {
    // 1. Fetch the decision by id, with its request joined.
    if (filters.id && !filters.requestId) return { data: decision, error: null };
    // 2. One-vote-per-person guard.
    if (filters.deciderId) {
      return { data: scenario.alreadyDecided ? { id: "dec-prior" } : null, error: null };
    }
    // 3. Every seat on this step.
    if (filters.stepId) {
      return {
        data: scenario.stepDecisions ?? [{ status: "APPROVED", deciderId: "user-1" }],
        error: null,
      };
    }
    // 4. Every decision on the request, for the next-step lookup.
    return {
      data: scenario.allDecisions ?? [{ id: "dec-1", stepId: "step-1", step: { stepOrder: 1 } }],
      error: null,
    };
  };

  tableResults["approval_group_members"] = {
    data: scenario.member === false ? null : { id: "m-1" },
    error: null,
  };

  return { request, decision };
}

const approve = {
  decisionId: "dec-1",
  tenantId: "tenant-1",
  userId: "user-1",
  userFullName: "Alice",
  status: "APPROVED" as const,
};

/** The most recent update issued against `table`. */
function lastUpdate(table: string) {
  return [...updateCalls].reverse().find((c) => c.table === table);
}

describe("processDecision — refusals", () => {
  beforeEach(resetMockState);

  it("refuses when the decision does not exist", async () => {
    tableResults["approval_decisions"] = { data: null, error: null };
    expect(await processDecision(approve)).toEqual({ error: "Decision not found" });
  });

  it("refuses a decision that is no longer pending", async () => {
    givenDecision({ status: "APPROVED" });
    expect(await processDecision(approve)).toEqual({
      error: "This step has already been decided",
    });
    expect(updateCalls).toHaveLength(0);
  });

  it("refuses an actor who is not in the approval group", async () => {
    givenDecision({ member: false });
    expect(await processDecision(approve)).toEqual({
      error: "You are not a member of this approval group",
    });
    expect(updateCalls).toHaveLength(0);
  });

  /**
   * ALL and MAJORITY steps hold one seat per group member and any member can
   * claim any pending seat. Without this guard one approver could take two
   * seats and satisfy a step alone — the exact thing those modes exist to
   * prevent.
   */
  it("refuses a second vote from someone who already decided this step", async () => {
    givenDecision({ approvalMode: "ALL", alreadyDecided: true });
    expect(await processDecision(approve)).toEqual({
      error: "You have already recorded a decision on this step",
    });
    expect(updateCalls).toHaveLength(0);
  });

  /**
   * Two approvers clicking at once: Postgres serialises the UPDATEs, so the
   * loser's compare-and-swap matches zero rows. It must bail rather than run
   * the side effects a second time.
   */
  it("bails when the compare-and-swap claim loses the race", async () => {
    givenDecision();
    claimResult.current = { data: null, error: null };
    expect(await processDecision(approve)).toEqual({
      error: "This step has already been decided",
    });
    // The claim itself is the only write; nothing downstream ran.
    expect(updateCalls.filter((c) => c.table === "approval_requests")).toHaveLength(0);
  });
});

describe("processDecision — claiming a seat", () => {
  beforeEach(resetMockState);

  it("stamps the decider, comment and timestamp on the claimed row", async () => {
    givenDecision();
    await processDecision({ ...approve, comment: "Looks good" });
    const claim = updateCalls.find((c) => c.table === "approval_decisions")!;
    expect(claim.data).toMatchObject({
      status: "APPROVED",
      deciderId: "user-1",
      comment: "Looks good",
    });
    expect((claim.data as Record<string, unknown>).decidedAt).toBeTruthy();
    // The compare-and-swap is what makes concurrent clicks safe.
    expect(claim.filters).toMatchObject({ id: "dec-1", status: "PENDING" });
  });

  it("stores a null comment rather than an empty string", async () => {
    givenDecision();
    await processDecision({ ...approve, comment: "" });
    const claim = updateCalls.find((c) => c.table === "approval_decisions")!;
    expect((claim.data as Record<string, unknown>).comment).toBeNull();
  });

  it("clears the decider's own stale approval notification", async () => {
    givenDecision();
    await processDecision(approve);
    expect(markNotificationsReadByRef).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      userId: "user-1",
      refId: "req-1",
    });
  });

  it("records the decision in the request history", async () => {
    givenDecision();
    await processDecision({ ...approve, comment: "Ship it" });
    const entry = insertCalls.find(
      (c) =>
        c.table === "approval_history" && (c.data as Record<string, unknown>).event === "APPROVED"
    );
    expect(entry).toBeDefined();
    expect((entry!.data as Record<string, unknown>).details).toContain("Ship it");
  });
});

describe("processDecision — ANY mode", () => {
  beforeEach(resetMockState);

  it("completes the request on a single approval when it is the only step", async () => {
    givenDecision({ approvalMode: "ANY" });
    expect(await processDecision(approve)).toMatchObject({
      success: true,
      requestComplete: true,
      requestStatus: "APPROVED",
    });
    expect(lastUpdate("approval_requests")!.data).toMatchObject({ status: "APPROVED" });
  });

  it("notifies the requester and audits the completion", async () => {
    givenDecision({ approvalMode: "ANY" });
    await processDecision(approve);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ userIds: ["user-9"], title: "Approval Complete" })
    );
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "approval.completed", entityId: "file-1" })
    );
  });
});

describe("processDecision — ALL mode", () => {
  beforeEach(resetMockState);

  /**
   * Three seats, one approver: the step is not resolved and the request stays
   * PENDING. The regression this guards is the deadlock — a step that could
   * never see a second approver because a single row had already been claimed.
   */
  it("holds the request open until every seat has approved", async () => {
    givenDecision({
      approvalMode: "ALL",
      stepDecisions: [
        { status: "APPROVED", deciderId: "user-1" },
        { status: "PENDING", deciderId: null },
        { status: "PENDING", deciderId: null },
      ],
    });
    expect(await processDecision(approve)).toMatchObject({
      success: true,
      requestComplete: false,
      requestStatus: "PENDING",
      stepResolved: false,
    });
    expect(updateCalls.filter((c) => c.table === "approval_requests")).toHaveLength(0);
  });

  it("resolves the step once the last seat approves", async () => {
    givenDecision({
      approvalMode: "ALL",
      stepDecisions: [
        { status: "APPROVED", deciderId: "user-1" },
        { status: "APPROVED", deciderId: "user-2" },
        { status: "APPROVED", deciderId: "user-3" },
      ],
    });
    expect(await processDecision(approve)).toMatchObject({
      requestComplete: true,
      requestStatus: "APPROVED",
    });
  });

  /**
   * Counted by distinct `deciderId`, not by row. Nothing in the schema ties a
   * seat to a person, so counting rows would let one approver's two claims
   * satisfy a three-member step.
   */
  it("counts distinct approvers, not approved rows", async () => {
    givenDecision({
      approvalMode: "ALL",
      stepDecisions: [
        { status: "APPROVED", deciderId: "user-1" },
        { status: "APPROVED", deciderId: "user-1" },
        { status: "APPROVED", deciderId: "user-2" },
      ],
    });
    expect(await processDecision(approve)).toMatchObject({ stepResolved: false });
  });

  it("ignores approved rows with no decider", async () => {
    givenDecision({
      approvalMode: "ALL",
      stepDecisions: [
        { status: "APPROVED", deciderId: "user-1" },
        { status: "APPROVED", deciderId: null },
      ],
    });
    expect(await processDecision(approve)).toMatchObject({ stepResolved: false });
  });
});

describe("processDecision — MAJORITY mode", () => {
  beforeEach(resetMockState);

  it("resolves at two of three", async () => {
    givenDecision({
      approvalMode: "MAJORITY",
      stepDecisions: [
        { status: "APPROVED", deciderId: "user-1" },
        { status: "APPROVED", deciderId: "user-2" },
        { status: "PENDING", deciderId: null },
      ],
    });
    expect(await processDecision(approve)).toMatchObject({ requestStatus: "APPROVED" });
  });

  it("does not resolve at one of three", async () => {
    givenDecision({
      approvalMode: "MAJORITY",
      stepDecisions: [
        { status: "APPROVED", deciderId: "user-1" },
        { status: "PENDING", deciderId: null },
        { status: "PENDING", deciderId: null },
      ],
    });
    expect(await processDecision(approve)).toMatchObject({ stepResolved: false });
  });

  /** Four seats need ceil(4/2) = 2 — a tie counts as a majority here. */
  it("needs half, rounded up, on an even number of seats", async () => {
    givenDecision({
      approvalMode: "MAJORITY",
      stepDecisions: [
        { status: "APPROVED", deciderId: "user-1" },
        { status: "APPROVED", deciderId: "user-2" },
        { status: "PENDING", deciderId: null },
        { status: "PENDING", deciderId: null },
      ],
    });
    expect(await processDecision(approve)).toMatchObject({ requestStatus: "APPROVED" });
  });
});

describe("processDecision — rejection", () => {
  beforeEach(resetMockState);

  const reject = { ...approve, status: "REJECTED" as const, comment: "Wall thickness is wrong" };

  /**
   * One rejection sinks the whole request, whatever the mode. An ALL step
   * waiting on two more approvals does not get to average them out.
   */
  it("rejects the entire request on a single rejection, even in ALL mode", async () => {
    givenDecision({
      approvalMode: "ALL",
      stepDecisions: [
        { status: "REJECTED", deciderId: "user-1" },
        { status: "PENDING", deciderId: null },
        { status: "PENDING", deciderId: null },
      ],
    });
    expect(await processDecision(reject)).toMatchObject({
      requestComplete: true,
      requestStatus: "REJECTED",
    });
    expect(lastUpdate("approval_requests")!.data).toMatchObject({ status: "REJECTED" });
  });

  it("tells the requester why", async () => {
    givenDecision();
    await processDecision(reject);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        userIds: ["user-9"],
        title: "Approval Rejected",
        message: expect.stringContaining("Wall thickness is wrong"),
      })
    );
  });

  it("audits the rejection with its comment", async () => {
    givenDecision();
    await processDecision(reject);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "approval.rejected",
        details: expect.objectContaining({ comment: "Wall thickness is wrong" }),
      })
    );
  });
});

describe("processDecision — advancing to the next step", () => {
  beforeEach(resetMockState);

  const twoSteps = [
    { id: "dec-1", stepId: "step-1", step: { stepOrder: 1 } },
    { id: "dec-2", stepId: "step-2", step: { stepOrder: 2 } },
  ];

  function givenNextStep(deadlineHours: number | null = null) {
    tableResults["approval_workflow_steps"] = {
      data: {
        id: "step-2",
        groupId: "group-2",
        signatureLabel: "QA Approval",
        deadlineHours,
        group: { id: "group-2", name: "QA Team" },
      },
      error: null,
    };
  }

  it("activates the next step's seats instead of completing the request", async () => {
    givenDecision({ allDecisions: twoSteps });
    givenNextStep();
    expect(await processDecision(approve)).toMatchObject({
      requestComplete: false,
      requestStatus: "PENDING",
      stepResolved: true,
      nextStep: 2,
    });
    // The waiting seat flips to PENDING…
    const activation = updateCalls.find(
      (c) => c.table === "approval_decisions" && c.filters.id === "dec-2"
    );
    expect(activation!.data).toMatchObject({ status: "PENDING" });
    // …and the request's cursor moves with it.
    expect(lastUpdate("approval_requests")!.data).toMatchObject({ currentStepOrder: 2 });
  });

  it("puts the next step on the clock when it has a deadline", async () => {
    givenDecision({ allDecisions: twoSteps });
    givenNextStep(24);
    await processDecision(approve);
    const deadlineUpdate = updateCalls.find(
      (c) =>
        c.table === "approval_decisions" &&
        (c.data as Record<string, unknown>).deadlineAt !== undefined
    );
    expect(deadlineUpdate).toBeDefined();
    expect((deadlineUpdate!.data as Record<string, unknown>).deadlineAt).toBeTruthy();
  });

  it("leaves the deadline alone when the next step has none", async () => {
    givenDecision({ allDecisions: twoSteps });
    givenNextStep(null);
    await processDecision(approve);
    expect(
      updateCalls.some(
        (c) =>
          c.table === "approval_decisions" &&
          (c.data as Record<string, unknown>).deadlineAt !== undefined
      )
    ).toBe(false);
  });

  it("notifies the next step's group, not the one that just approved", async () => {
    givenDecision({ allDecisions: twoSteps });
    givenNextStep();
    await processDecision(approve);
    expect(notifyApprovalGroupMembers).toHaveBeenCalledWith(
      expect.objectContaining({ groupIds: ["group-2"], title: "Approval Required" })
    );
  });

  it("does not tell the requester the request is complete", async () => {
    givenDecision({ allDecisions: twoSteps });
    givenNextStep();
    await processDecision(approve);
    expect(notify).not.toHaveBeenCalled();
  });

  /**
   * The next step is found relative to the request's own cursor, not by
   * assuming step 1. A request already on step 2 must advance to step 3.
   */
  it("advances relative to the request's current step, not from the start", async () => {
    givenDecision({
      request: { currentStepOrder: 2 },
      allDecisions: [
        { id: "dec-1", stepId: "step-1", step: { stepOrder: 1 } },
        { id: "dec-2", stepId: "step-2", step: { stepOrder: 2 } },
        { id: "dec-3", stepId: "step-3", step: { stepOrder: 3 } },
      ],
    });
    tableResults["approval_workflow_steps"] = {
      data: {
        id: "step-3",
        groupId: "group-3",
        signatureLabel: "Final",
        deadlineHours: null,
        group: { id: "group-3", name: "Management" },
      },
      error: null,
    };
    expect(await processDecision(approve)).toMatchObject({ nextStep: 3 });
  });
});

describe("processDecision — file transition side effects", () => {
  beforeEach(resetMockState);

  function givenTransition(from: string, to: string, file: Record<string, unknown> = {}) {
    givenDecision({ request: { entityType: "file", transitionId: "trans-1" } });
    tableResults["lifecycle_transitions"] = {
      data: {
        id: "trans-1",
        name: `${from} to ${to}`,
        toState: { name: to },
        fromState: { name: from },
      },
      error: null,
    };
    tableResults["files"] = {
      data: { name: "bracket.sldprt", revision: "A", createdById: "user-9", ...file },
      error: null,
    };
    tableResults["tenant_users"] = { data: { fullName: "Alice" }, error: null };
  }

  it("moves the file into the transition's target state", async () => {
    givenTransition("WIP", "In Review");
    await processDecision(approve);
    expect(lastUpdate("files")!.data).toMatchObject({ lifecycleState: "In Review" });
  });

  it("freezes a file on release", async () => {
    givenTransition("In Review", "Released");
    await processDecision(approve);
    expect(lastUpdate("files")!.data).toMatchObject({
      lifecycleState: "Released",
      isFrozen: true,
    });
  });

  it("freezes a file made obsolete", async () => {
    givenTransition("Released", "Obsolete");
    await processDecision(approve);
    expect(lastUpdate("files")!.data).toMatchObject({ isFrozen: true });
  });

  /**
   * Reopening a released file starts the next revision — a released rev A is
   * immutable, so work continues on B rather than editing history.
   */
  it("bumps the revision and thaws the file when a release is reopened", async () => {
    givenTransition("Released", "WIP", { revision: "A" });
    await processDecision(approve);
    expect(lastUpdate("files")!.data).toMatchObject({
      lifecycleState: "WIP",
      revision: "B",
      isFrozen: false,
    });
  });

  it("thaws without a revision bump when the file has no revision recorded", async () => {
    givenTransition("Released", "WIP", { revision: null });
    await processDecision(approve);
    const data = lastUpdate("files")!.data as Record<string, unknown>;
    expect(data.isFrozen).toBe(false);
    expect(data.revision).toBeUndefined();
  });

  it("announces the transition under the decider's name", async () => {
    givenTransition("WIP", "Released");
    await processDecision(approve);
    expect(notifyFileTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: "file-1",
        fileName: "bracket.sldprt",
        toStateName: "Released",
        actorId: "user-1",
        actorFullName: "Alice",
      })
    );
  });

  it("falls back to a generic actor name when the decider cannot be resolved", async () => {
    givenTransition("WIP", "Released");
    tableResults["tenant_users"] = { data: null, error: null };
    await processDecision(approve);
    expect(notifyFileTransition).toHaveBeenCalledWith(
      expect.objectContaining({ actorFullName: "A reviewer" })
    );
  });

  it("audits the state change with the new state", async () => {
    givenTransition("WIP", "Released");
    await processDecision(approve);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "file.transition.approved",
        details: expect.objectContaining({ newState: "Released" }),
      })
    );
  });

  /** A rejection must not move the file. */
  it("leaves the file untouched when the request is rejected", async () => {
    givenTransition("WIP", "Released");
    await processDecision({ ...approve, status: "REJECTED" });
    expect(updateCalls.filter((c) => c.table === "files")).toHaveLength(0);
    expect(notifyFileTransition).not.toHaveBeenCalled();
  });

  it("does nothing when the transition row has gone missing", async () => {
    givenTransition("WIP", "Released");
    tableResults["lifecycle_transitions"] = { data: null, error: null };
    await processDecision(approve);
    expect(updateCalls.filter((c) => c.table === "files")).toHaveLength(0);
  });

  /** A request with no transition attached has nothing to apply. */
  it("does nothing for a file request with no transition", async () => {
    givenDecision({ request: { entityType: "file", transitionId: null } });
    await processDecision(approve);
    expect(updateCalls.filter((c) => c.table === "files")).toHaveLength(0);
  });
});

describe("processDecision — ECO side effects", () => {
  beforeEach(resetMockState);

  it("approves the ECO when the request completes", async () => {
    givenDecision({ request: { entityType: "eco", entityId: "eco-1", transitionId: null } });
    await processDecision(approve);
    expect(lastUpdate("ecos")).toMatchObject({
      data: { status: "APPROVED" },
      filters: { id: "eco-1" },
    });
  });

  it("rejects the ECO when the request is rejected", async () => {
    givenDecision({ request: { entityType: "eco", entityId: "eco-1", transitionId: null } });
    await processDecision({ ...approve, status: "REJECTED" });
    expect(lastUpdate("ecos")!.data).toMatchObject({ status: "REJECTED" });
  });
});

// ── rejectForRework ────────────────────────────────────────────────────────

describe("rejectForRework", () => {
  beforeEach(resetMockState);

  const rework = {
    decisionId: "dec-1",
    tenantId: "tenant-1",
    userId: "user-1",
    userFullName: "Alice",
    comment: "Add a chamfer to the mounting face",
  };

  it("refuses when the decision does not exist", async () => {
    tableResults["approval_decisions"] = { data: null, error: null };
    expect(await rejectForRework(rework)).toEqual({ error: "Decision not found" });
  });

  it("refuses a decision that is already decided", async () => {
    givenDecision({ status: "APPROVED" });
    expect(await rejectForRework(rework)).toEqual({ error: "Step already decided" });
    expect(updateCalls).toHaveLength(0);
  });

  it("refuses an actor outside the approval group", async () => {
    givenDecision({ member: false });
    expect(await rejectForRework(rework)).toEqual({ error: "Not in approval group" });
    expect(updateCalls).toHaveLength(0);
  });

  /**
   * Rework is not rejection: the request goes back to the requester and can be
   * resubmitted, so it must land in REWORK rather than the terminal REJECTED.
   */
  it("marks the decision and the request as REWORK, not REJECTED", async () => {
    givenDecision();
    expect(await rejectForRework(rework)).toEqual({ success: true });
    expect(lastUpdate("approval_decisions")!.data).toMatchObject({
      status: "REWORK",
      deciderId: "user-1",
      comment: rework.comment,
    });
    expect(lastUpdate("approval_requests")!.data).toMatchObject({ status: "REWORK" });
  });

  it("tells the requester what to change, naming the reviewer", async () => {
    givenDecision();
    await rejectForRework(rework);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        userIds: ["user-9"],
        title: "Rework Requested",
        message: expect.stringContaining("Add a chamfer"),
      })
    );
    expect((notify as ReturnType<typeof vi.fn>).mock.calls[0][0].message).toContain("Alice");
  });

  it("records the request in history and clears the reviewer's notification", async () => {
    givenDecision();
    await rejectForRework(rework);
    const history = insertCalls.find(
      (c) =>
        c.table === "approval_history" &&
        (c.data as Record<string, unknown>).event === "REWORK_REQUESTED"
    );
    expect(history).toBeDefined();
    expect(markNotificationsReadByRef).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", refId: "req-1" })
    );
  });
});

// ── resubmitAfterRework ────────────────────────────────────────────────────

describe("resubmitAfterRework", () => {
  beforeEach(resetMockState);

  const resubmit = {
    requestId: "req-1",
    tenantId: "tenant-1",
    userId: "user-1",
    userFullName: "Alice",
  };

  function givenRequest(overrides: Record<string, unknown> = {}) {
    tableResults["approval_requests"] = {
      data: {
        id: "req-1",
        tenantId: "tenant-1",
        requestedById: "user-1",
        status: "REWORK",
        title: "Release bracket.sldprt",
        ...overrides,
      },
      error: null,
    };
  }

  function givenDecisions(step1DeadlineHours: number | null = null) {
    tableResults["approval_decisions"] = {
      data: [
        {
          id: "dec-1",
          step: { stepOrder: 1, deadlineHours: step1DeadlineHours, groupId: "group-1" },
        },
        { id: "dec-2", step: { stepOrder: 2, deadlineHours: 12, groupId: "group-2" } },
      ],
      error: null,
    };
  }

  it("refuses when the request does not exist", async () => {
    tableResults["approval_requests"] = { data: null, error: null };
    expect(await resubmitAfterRework(resubmit)).toEqual({ error: "Request not found" });
  });

  it("refuses anyone but the requester", async () => {
    givenRequest({ requestedById: "user-2" });
    expect(await resubmitAfterRework(resubmit)).toEqual({
      error: "Only the requester can resubmit",
    });
  });

  it("refuses a request that is not in rework", async () => {
    givenRequest({ status: "PENDING" });
    expect(await resubmitAfterRework(resubmit)).toEqual({
      error: "Request must be in rework status",
    });
    expect(updateCalls).toHaveLength(0);
  });

  /**
   * Resubmitting rewinds the whole workflow: step 1 goes live again and every
   * later step returns to WAITING. Prior deciders and comments are cleared so
   * the second pass is a fresh review, not an amended first one.
   */
  it("rewinds step 1 to PENDING and later steps to WAITING", async () => {
    givenRequest();
    givenDecisions();
    expect(await resubmitAfterRework(resubmit)).toEqual({ success: true });

    const step1 = updateCalls.find(
      (c) => c.table === "approval_decisions" && c.filters.id === "dec-1"
    )!;
    const step2 = updateCalls.find(
      (c) => c.table === "approval_decisions" && c.filters.id === "dec-2"
    )!;
    expect(step1.data).toMatchObject({ status: "PENDING", deciderId: null, comment: null });
    expect(step2.data).toMatchObject({ status: "WAITING", deciderId: null, comment: null });
  });

  it("restarts the clock on step 1 only", async () => {
    givenRequest();
    givenDecisions(48);
    await resubmitAfterRework(resubmit);
    const step1 = updateCalls.find(
      (c) => c.table === "approval_decisions" && c.filters.id === "dec-1"
    )!;
    const step2 = updateCalls.find(
      (c) => c.table === "approval_decisions" && c.filters.id === "dec-2"
    )!;
    expect((step1.data as Record<string, unknown>).deadlineAt).toBeTruthy();
    // Step 2 has a deadline configured, but it is not on the clock yet.
    expect((step2.data as Record<string, unknown>).deadlineAt).toBeNull();
  });

  it("returns the request to PENDING at step 1 and clears its completion", async () => {
    givenRequest();
    givenDecisions();
    await resubmitAfterRework(resubmit);
    expect(lastUpdate("approval_requests")!.data).toMatchObject({
      status: "PENDING",
      currentStepOrder: 1,
      completedAt: null,
    });
  });

  it("re-notifies step 1's group and records the resubmission", async () => {
    givenRequest();
    givenDecisions();
    await resubmitAfterRework(resubmit);
    expect(notifyApprovalGroupMembers).toHaveBeenCalledWith(
      expect.objectContaining({ groupIds: ["group-1"], title: "Approval Re-Requested" })
    );
    const history = insertCalls.find(
      (c) =>
        c.table === "approval_history" &&
        (c.data as Record<string, unknown>).event === "RESUBMITTED"
    );
    expect(history).toBeDefined();
  });

  it("clears the requester's own rework notification", async () => {
    givenRequest();
    givenDecisions();
    await resubmitAfterRework(resubmit);
    expect(markNotificationsReadByRef).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      userId: "user-1",
      refId: "req-1",
    });
  });
});

// ── getRequestTimeline ─────────────────────────────────────────────────────

describe("getRequestTimeline", () => {
  beforeEach(resetMockState);

  it("returns the history rows for a request", async () => {
    tableResults["approval_history"] = {
      data: [{ id: "h-1", event: "CREATED", user: { fullName: "Alice" } }],
      error: null,
    };
    const rows = await getRequestTimeline("req-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: "CREATED" });
  });

  it("returns an empty array rather than null when there is no history", async () => {
    tableResults["approval_history"] = { data: null, error: null };
    expect(await getRequestTimeline("req-1")).toEqual([]);
  });
});
