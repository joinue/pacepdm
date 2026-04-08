import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock setup (vi.hoisted so variables are available in vi.mock factories) ──

const { tableResults, insertCalls, updateCalls, mockFrom } = vi.hoisted(() => {
  type QueryResult = { data: unknown; error: unknown };

  const tableResults: Record<string, QueryResult> = {};
  const insertCalls: Array<{ table: string; data: unknown }> = [];
  const updateCalls: Array<{ table: string; data: unknown; filters: Record<string, unknown> }> = [];

  function makeChain(table: string) {
    const filters: Record<string, unknown> = {};
    const chain: Record<string, (...args: unknown[]) => unknown> = {};

    const resolvable = () => tableResults[table] || { data: null, error: null };

    for (const m of ["select", "eq", "in", "neq", "is", "order", "limit", "match"] as const) {
      chain[m] = (...args: unknown[]) => {
        if (m === "eq" && args.length === 2) filters[args[0] as string] = args[1];
        return chain;
      };
    }

    chain.single = () => resolvable();

    chain.insert = (data: unknown) => {
      insertCalls.push({ table, data });
      return Promise.resolve({ data: null, error: null });
    };

    chain.update = (data: unknown) => {
      const entry = { table, data, filters: { ...filters } };
      updateCalls.push(entry);
      const updateChain: Record<string, (...args: unknown[]) => unknown> = {};
      for (const m of ["eq", "in"] as const) {
        updateChain[m] = (...args: unknown[]) => {
          if (m === "eq" && args.length === 2) entry.filters[args[0] as string] = args[1];
          return updateChain;
        };
      }
      updateChain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
      return updateChain;
    };

    chain.then = (resolve: (v: unknown) => void) => resolve(resolvable());

    return chain;
  }

  const mockFrom = (table: string) => makeChain(table);

  return { tableResults, insertCalls, updateCalls, mockFrom };
});

vi.mock("@/lib/db", () => ({
  getServiceClient: () => ({ from: mockFrom }),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/notifications", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
  notifyApprovalGroupMembers: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("uuid", () => ({ v4: () => "mock-uuid" }));

import { startWorkflow, recallRequest, findWorkflowForTrigger } from "./approval-engine";
import { logAudit } from "./audit";
import { notifyApprovalGroupMembers } from "./notifications";

// ── Helpers ─────────────────────────────────────────────────────────────────

function resetMockState() {
  vi.clearAllMocks();
  insertCalls.length = 0;
  updateCalls.length = 0;
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
      data: [{
        id: "step-1", groupId: "group-1", stepOrder: 1,
        approvalMode: "ANY", signatureLabel: "Engineering Approval",
        deadlineHours: 48, group: { id: "group-1", name: "Engineering" },
      }],
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
          id: "step-1", groupId: "group-1", stepOrder: 1,
          approvalMode: "ANY", signatureLabel: "Design", deadlineHours: null,
          group: { id: "group-1", name: "Design Team" },
        },
        {
          id: "step-2", groupId: "group-2", stepOrder: 2,
          approvalMode: "ALL", signatureLabel: "QA", deadlineHours: 24,
          group: { id: "group-2", name: "QA Team" },
        },
      ],
      error: null,
    };

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
      data: [{
        id: "step-1", groupId: "group-1", stepOrder: 1,
        approvalMode: "ANY", signatureLabel: "Review", deadlineHours: null,
        group: { id: "group-1", name: "Reviewers" },
      }],
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
      data: [{
        id: "step-1", groupId: "group-1", stepOrder: 1,
        approvalMode: "ANY", signatureLabel: "OK", deadlineHours: null,
        group: { id: "group-1", name: "Team" },
      }],
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
      data: [{
        id: "step-1", groupId: "group-1", stepOrder: 1,
        approvalMode: "ANY", signatureLabel: "Approve", deadlineHours: null,
        group: { id: "group-1", name: "Engineers" },
      }],
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

describe("recallRequest", () => {
  beforeEach(resetMockState);

  it("returns error when request not found", async () => {
    tableResults["approval_requests"] = { data: null, error: null };
    const result = await recallRequest({
      requestId: "req-1", tenantId: "tenant-1",
      userId: "user-1", userFullName: "John Doe",
    });
    expect(result.error).toBe("Request not found");
  });

  it("returns error when non-requester tries to recall", async () => {
    tableResults["approval_requests"] = {
      data: { id: "req-1", requestedById: "user-2", status: "PENDING" },
      error: null,
    };
    const result = await recallRequest({
      requestId: "req-1", tenantId: "tenant-1",
      userId: "user-1", userFullName: "John Doe",
    });
    expect(result.error).toBe("Only the requester can recall");
  });

  it("returns error when request is not pending", async () => {
    tableResults["approval_requests"] = {
      data: { id: "req-1", requestedById: "user-1", status: "APPROVED" },
      error: null,
    };
    const result = await recallRequest({
      requestId: "req-1", tenantId: "tenant-1",
      userId: "user-1", userFullName: "John Doe",
    });
    expect(result.error).toBe("Can only recall pending requests");
  });

  it("succeeds when requester recalls their pending request", async () => {
    tableResults["approval_requests"] = {
      data: { id: "req-1", requestedById: "user-1", status: "PENDING" },
      error: null,
    };

    const result = await recallRequest({
      requestId: "req-1", tenantId: "tenant-1",
      userId: "user-1", userFullName: "John Doe",
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
