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
      updateChain.eq = () => updateChain;
      updateChain.then = ((resolve: (v: unknown) => void) => resolve({ data: null, error: null })) as unknown as (...args: unknown[]) => unknown;
      return updateChain;
    };

    chain.insert = (data: unknown) => {
      return { select: () => ({ single: () => ({ data: null, error: null }) }), data: null, error: null };
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

vi.mock("@/lib/db", () => ({
  getServiceClient: () => ({ from: mockFrom }),
}));

vi.mock("@/lib/auth", () => ({
  getApiTenantUser: () => Promise.resolve(mockTenantUser.current),
  hasPermission: (perms: string[], required: string) =>
    perms.includes("*") || perms.includes(required),
  PERMISSIONS: { FILE_EDIT: "file.edit" },
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("uuid", () => ({ v4: () => "mock-uuid" }));

vi.mock("@/lib/folder-access-guards", () => ({
  requireFileAccess: vi.fn().mockResolvedValue({ ok: true }),
}));

import { PUT } from "./route";

// ── Helpers ─────────────────────────────────────────────────────────────

function resetMockState() {
  vi.clearAllMocks();
  updateCalls.length = 0;
  for (const key of Object.keys(tableResults)) delete tableResults[key];
}

function makeRequest(body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest("http://localhost/api/files/file-1/metadata", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = Promise.resolve({ fileId: "file-1" });

const editor = {
  id: "user-1",
  tenantId: "tenant-1",
  fullName: "Alice",
  role: { permissions: ["file.edit"] },
};

const admin = {
  id: "admin-1",
  tenantId: "tenant-1",
  fullName: "Admin",
  role: { permissions: ["*"] },
};

const wipFile = {
  id: "file-1",
  tenantId: "tenant-1",
  name: "bracket.sldprt",
  isFrozen: false,
  isCheckedOut: false,
  checkedOutById: null,
  folderId: "folder-1",
};

// ── Tests ───────────────────────────────────────────────────────────────

describe("PUT /api/files/[fileId]/metadata", () => {
  beforeEach(resetMockState);

  it("returns 409 for frozen files (non-admin)", async () => {
    mockTenantUser.current = editor;
    tableResults["files"] = {
      data: { ...wipFile, isFrozen: true },
      error: null,
    };
    const res = await PUT(makeRequest({ description: "new" }), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/frozen/i);
  });

  it("returns 423 when file is checked out by another user", async () => {
    mockTenantUser.current = editor;
    tableResults["files"] = {
      data: { ...wipFile, isCheckedOut: true, checkedOutById: "user-other" },
      error: null,
    };
    const res = await PUT(makeRequest({ description: "new" }), { params });
    expect(res.status).toBe(423);
    const body = await res.json();
    expect(body.error).toMatch(/checked out by another user/i);
  });

  it("allows checkout owner to edit metadata", async () => {
    mockTenantUser.current = editor;
    tableResults["files"] = {
      data: { ...wipFile, isCheckedOut: true, checkedOutById: "user-1" },
      error: null,
    };
    const res = await PUT(makeRequest({ description: "updated" }), { params });
    expect(res.status).toBe(200);
  });

  it("allows admin to edit metadata on checked-out file", async () => {
    mockTenantUser.current = admin;
    tableResults["files"] = {
      data: { ...wipFile, isCheckedOut: true, checkedOutById: "user-other" },
      error: null,
    };
    const res = await PUT(makeRequest({ description: "admin edit" }), { params });
    expect(res.status).toBe(200);
  });

  it("succeeds for unlocked WIP file", async () => {
    mockTenantUser.current = editor;
    tableResults["files"] = { data: { ...wipFile }, error: null };
    const res = await PUT(makeRequest({ partNumber: "PN-001", description: "test" }), { params });
    expect(res.status).toBe(200);

    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    const fileUpdate = updateCalls.find((c) => c.table === "files");
    expect(fileUpdate?.data).toMatchObject({
      partNumber: "PN-001",
      description: "test",
    });
  });
});
