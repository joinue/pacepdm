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
      // Return a chainable object that resolves to the same data
      const updateChain: Record<string, (...args: unknown[]) => unknown> = {};
      for (const m of ["eq", "select"] as const) {
        updateChain[m] = () => updateChain;
      }
      updateChain.single = () => ({ data: { id: "file-1", isCheckedOut: true }, error: null });
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

vi.mock("@/lib/db", () => ({
  getServiceClient: () => ({ from: mockFrom }),
}));

vi.mock("@/lib/auth", () => ({
  getApiTenantUser: () => Promise.resolve(mockTenantUser.current),
  hasPermission: (perms: string[], required: string) =>
    perms.includes("*") || perms.includes(required),
  PERMISSIONS: {
    FILE_CHECKOUT: "file.checkout",
    FILE_CHECKIN: "file.checkin",
  },
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
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

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost/api/files/file-1/checkout", { method: "POST" });
}

const params = Promise.resolve({ fileId: "file-1" });

const engineer = {
  id: "user-1",
  tenantId: "tenant-1",
  fullName: "Alice",
  role: { permissions: ["file.checkout", "file.checkin"] },
};

const viewer = {
  id: "user-2",
  tenantId: "tenant-1",
  fullName: "Bob",
  role: { permissions: ["file.view"] },
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

describe("POST /api/files/[fileId]/checkout", () => {
  beforeEach(resetMockState);

  it("returns 401 when not authenticated", async () => {
    mockTenantUser.current = null;
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(401);
  });

  it("returns 403 without FILE_CHECKOUT permission", async () => {
    mockTenantUser.current = viewer;
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(403);
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

  it("returns 409 for frozen/released files", async () => {
    mockTenantUser.current = engineer;
    tableResults["files"] = {
      data: { ...wipFile, isFrozen: true },
      error: null,
    };
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/frozen/i);
  });

  it("returns 409 if already checked out", async () => {
    mockTenantUser.current = engineer;
    tableResults["files"] = {
      data: { ...wipFile, isCheckedOut: true, checkedOutById: "user-other" },
      error: null,
    };
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already checked out/i);
  });

  it("succeeds for a WIP file and logs audit", async () => {
    mockTenantUser.current = engineer;
    tableResults["files"] = { data: { ...wipFile }, error: null };
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(200);

    // Verify the update was called with checkout fields
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].table).toBe("files");
    expect(updateCalls[0].data).toMatchObject({
      isCheckedOut: true,
      checkedOutById: "user-1",
    });

    // Verify audit log
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        userId: "user-1",
        action: "file.checkout",
        entityId: "file-1",
      })
    );
  });
});
