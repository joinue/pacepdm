import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mock setup ──────────────────────────────────────────────────────────

const { tableResults, updateCalls, mockFrom } = vi.hoisted(() => {
  type QueryResult = { data: unknown; error: unknown };

  const tableResults: Record<string, QueryResult> = {};
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
    chain.maybeSingle = () => resolvable();

    chain.update = (data: unknown) => {
      const entry = { table, data, filters: { ...filters } };
      updateCalls.push(entry);
      const updateChain: Record<string, (...args: unknown[]) => unknown> = {};
      for (const m of ["eq"] as const) {
        updateChain[m] = (...args: unknown[]) => {
          if (args.length === 2) entry.filters[args[0] as string] = args[1];
          return updateChain;
        };
      }
      updateChain.then = ((resolve: (v: unknown) => void) => resolve({ data: null, error: null })) as unknown as (...args: unknown[]) => unknown;
      return updateChain;
    };

    chain.then = ((resolve: (v: unknown) => void) => resolve(resolvable())) as unknown as (...args: unknown[]) => unknown;

    return chain;
  }

  const mockFrom = (table: string) => makeChain(table);

  return { tableResults, updateCalls, mockFrom };
});

const mockTenantUser = vi.hoisted(() => ({
  current: null as {
    id: string;
    tenantId: string;
    fullName: string;
    role: { permissions: string[] };
  } | null,
}));

const mockStartWorkflow = vi.hoisted(() => vi.fn());
const mockFindWorkflow = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({
  getServiceClient: () => ({ from: mockFrom }),
}));

vi.mock("@/lib/auth", () => ({
  getApiTenantUser: () => Promise.resolve(mockTenantUser.current),
  hasPermission: (perms: string[], required: string) =>
    perms.includes("*") || perms.includes(required),
  PERMISSIONS: { FILE_TRANSITION: "file.transition" },
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/notifications", () => ({
  notifyFileTransition: vi.fn().mockResolvedValue(undefined),
  sideEffect: vi.fn((promise: Promise<unknown>) => promise),
}));

vi.mock("@/lib/approval-engine", () => ({
  startWorkflow: mockStartWorkflow,
  findWorkflowForTrigger: mockFindWorkflow,
}));

vi.mock("@/lib/folder-access-guards", () => ({
  requireFileAccess: vi.fn().mockResolvedValue({ ok: true }),
}));

import { POST } from "./route";
import { logAudit } from "@/lib/audit";

// ── Helpers ─────────────────────────────────────────────────────────────

function resetMockState() {
  vi.clearAllMocks();
  updateCalls.length = 0;
  for (const key of Object.keys(tableResults)) delete tableResults[key];
}

function makeRequest(transitionId = "trans-1"): NextRequest {
  return new NextRequest("http://localhost/api/files/file-1/transition", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transitionId }),
  });
}

const params = Promise.resolve({ fileId: "file-1" });

const engineer = {
  id: "user-1",
  tenantId: "tenant-1",
  fullName: "Alice",
  role: { permissions: ["file.transition"] },
};

const wipFile = {
  id: "file-1",
  tenantId: "tenant-1",
  name: "bracket.sldprt",
  isFrozen: false,
  isCheckedOut: false,
  lifecycleState: "WIP",
  revision: "A",
  createdById: "user-1",
  folderId: "folder-1",
};

const releaseTransition = {
  id: "trans-1",
  name: "Release",
  lifecycleId: null,
  fromState: { name: "WIP" },
  toState: { name: "Released" },
  lifecycle: { tenantId: "tenant-1" },
  requiresApproval: false,
};

const reviseTransition = {
  id: "trans-2",
  name: "Revise",
  lifecycleId: null,
  fromState: { name: "Released" },
  toState: { name: "WIP" },
  lifecycle: { tenantId: "tenant-1" },
  requiresApproval: false,
};

// ── Tests ───────────────────────────────────────────────────────────────

describe("POST /api/files/[fileId]/transition", () => {
  beforeEach(resetMockState);

  it("returns 401 when not authenticated", async () => {
    mockTenantUser.current = null;
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(401);
  });

  it("returns 403 without FILE_TRANSITION permission", async () => {
    mockTenantUser.current = { ...engineer, role: { permissions: ["file.view"] } };
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(403);
  });

  it("returns 409 if file is checked out", async () => {
    mockTenantUser.current = engineer;
    tableResults["files"] = {
      data: { ...wipFile, isCheckedOut: true },
      error: null,
    };
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/checked.out/i);
  });

  it("returns 404 for file in another tenant", async () => {
    mockTenantUser.current = engineer;
    tableResults["files"] = {
      data: { ...wipFile, tenantId: "tenant-OTHER" },
      error: null,
    };
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(404);
  });

  it("returns 400 if transition doesn't match current state", async () => {
    mockTenantUser.current = engineer;
    tableResults["files"] = { data: { ...wipFile }, error: null };
    tableResults["lifecycle_transitions"] = {
      data: { ...releaseTransition, fromState: { name: "Released" } },
      error: null,
    };
    mockFindWorkflow.mockResolvedValue(null);
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not valid from current state/i);
  });

  it("releases file: sets isFrozen=true, lifecycleState=Released", async () => {
    mockTenantUser.current = engineer;
    tableResults["files"] = { data: { ...wipFile }, error: null };
    tableResults["lifecycle_transitions"] = {
      data: releaseTransition,
      error: null,
    };
    mockFindWorkflow.mockResolvedValue(null);

    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.newState).toBe("Released");

    // Verify DB update
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].data).toMatchObject({
      lifecycleState: "Released",
      isFrozen: true,
    });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "file.transition",
        details: expect.objectContaining({
          from: "WIP",
          to: "Released",
        }),
      })
    );
  });

  it("revise: bumps revision letter and unfreezes", async () => {
    mockTenantUser.current = engineer;
    tableResults["files"] = {
      data: { ...wipFile, lifecycleState: "Released", isFrozen: true },
      error: null,
    };
    tableResults["lifecycle_transitions"] = {
      data: reviseTransition,
      error: null,
    };
    mockFindWorkflow.mockResolvedValue(null);

    const res = await POST(makeRequest("trans-2"), { params });
    expect(res.status).toBe(200);

    expect(updateCalls[0].data).toMatchObject({
      lifecycleState: "WIP",
      isFrozen: false,
      revision: "B", // A → B
    });
  });

  it("rejects a transition whose lifecycle is in another tenant", async () => {
    mockTenantUser.current = engineer;
    tableResults["files"] = { data: { ...wipFile }, error: null };
    tableResults["lifecycle_transitions"] = {
      data: { ...releaseTransition, lifecycle: { tenantId: "tenant-OTHER" } },
      error: null,
    };
    mockFindWorkflow.mockResolvedValue(null);

    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid transition/i);
    expect(updateCalls.length).toBe(0);
  });

  it("rejects a transition that does not belong to the file's lifecycle", async () => {
    mockTenantUser.current = engineer;
    tableResults["files"] = {
      data: { ...wipFile, lifecycleId: "lc-1" },
      error: null,
    };
    tableResults["lifecycle_transitions"] = {
      data: { ...releaseTransition, lifecycleId: "lc-2" },
      error: null,
    };
    mockFindWorkflow.mockResolvedValue(null);

    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/file's lifecycle/i);
    expect(updateCalls.length).toBe(0);
  });

  it("routes through approval engine when workflow exists", async () => {
    mockTenantUser.current = engineer;
    tableResults["files"] = { data: { ...wipFile }, error: null };
    tableResults["lifecycle_transitions"] = {
      data: releaseTransition,
      error: null,
    };
    mockFindWorkflow.mockResolvedValue({ id: "wf-1" });
    mockStartWorkflow.mockResolvedValue({ success: true, requestId: "req-1" });

    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(200);

    expect(mockStartWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        workflowId: "wf-1",
        entityId: "file-1",
        type: "FILE_TRANSITION",
      })
    );

    // Should NOT directly update the file (approval engine handles that)
    expect(updateCalls.length).toBe(0);
  });
});
