import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Checkout is the vault's pessimistic lock, so the cases that matter are the
 * refusals: another tenant's file, a frozen file, one already locked.
 *
 * The Supabase mock honours `.eq()` filters rather than returning a fixed row.
 * That is what lets the cross-tenant case be a real test: the route runs on
 * `withTenant`, whose scoped client applies `.eq("tenantId", caller)`, and the
 * mock returns nothing when the tenant does not match. A mock that ignored
 * filters would pass whether or not the scoping existed.
 */

const { tableResults, updateCalls, mockFrom } = vi.hoisted(() => {
  type QueryResult = { data: unknown; error: unknown };
  type Handler = QueryResult | ((filters: Record<string, unknown>) => QueryResult);

  const tableResults: Record<string, Handler> = {};
  const updateCalls: Array<{ table: string; data: unknown; filters: Record<string, unknown> }> = [];

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

    chain.update = (data: unknown) => {
      updateCalls.push({ table, data, filters: { ...filters } });
      const updateChain: Record<string, (...args: unknown[]) => unknown> = {};
      for (const m of ["eq", "select"] as const) updateChain[m] = () => updateChain;
      updateChain.single = () => ({ data: { id: FILE_ID, isCheckedOut: true }, error: null });
      return updateChain;
    };

    chain.then = ((resolve: (v: unknown) => void) => resolve(resolvable())) as unknown as (
      ...args: unknown[]
    ) => unknown;

    return chain;
  }

  return { tableResults, updateCalls, mockFrom: (table: string) => makeChain(table) };
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
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

// Only the ACL scope resolver is stubbed — `loadFile` itself runs for real, so
// the tenant filter it applies is under test rather than mocked away.
vi.mock("@/lib/folder-access", async () => {
  const actual = await vi.importActual<typeof import("@/lib/folder-access")>("@/lib/folder-access");
  return { ...actual, getFolderAccessScope: vi.fn(async () => actual.openScope()) };
});

import { POST } from "./route";
import { logAudit } from "@/lib/audit";

const FILE_ID = "22222222-2222-4222-8222-222222222222";

function makeRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/files/${FILE_ID}/checkout`, { method: "POST" });
}

const params = Promise.resolve({ fileId: FILE_ID });

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
  id: FILE_ID,
  tenantId: "tenant-1",
  name: "bracket.sldprt",
  isFrozen: false,
  isCheckedOut: false,
  checkedOutById: null,
  folderId: "folder-1",
};

/** Serve `row` only to the tenant that actually owns it. */
function ownedBy(tenantId: string, row: Record<string, unknown>) {
  tableResults["files"] = (filters) =>
    filters.tenantId === tenantId ? { data: row, error: null } : { data: null, error: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  updateCalls.length = 0;
  for (const key of Object.keys(tableResults)) delete tableResults[key];
});

describe("POST /api/files/[fileId]/checkout", () => {
  it("returns 401 when not authenticated", async () => {
    mockTenantUser.current = null;
    expect((await POST(makeRequest(), { params })).status).toBe(401);
  });

  it("returns 403 without FILE_CHECKOUT permission", async () => {
    mockTenantUser.current = viewer;
    expect((await POST(makeRequest(), { params })).status).toBe(403);
  });

  it("returns 400 for a malformed file id, before touching the database", async () => {
    mockTenantUser.current = engineer;
    const res = await POST(makeRequest(), { params: Promise.resolve({ fileId: "file-1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a file in another tenant", async () => {
    mockTenantUser.current = engineer;
    ownedBy("tenant-OTHER", { ...wipFile, tenantId: "tenant-OTHER" });
    expect((await POST(makeRequest(), { params })).status).toBe(404);
  });

  it("returns 409 for frozen/released files", async () => {
    mockTenantUser.current = engineer;
    ownedBy("tenant-1", { ...wipFile, isFrozen: true });
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/frozen/i);
  });

  it("returns 409 if already checked out", async () => {
    mockTenantUser.current = engineer;
    ownedBy("tenant-1", { ...wipFile, isCheckedOut: true, checkedOutById: "user-other" });
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already checked out/i);
  });

  it("succeeds for a WIP file and logs audit", async () => {
    mockTenantUser.current = engineer;
    ownedBy("tenant-1", { ...wipFile });
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(200);

    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].table).toBe("files");
    expect(updateCalls[0].data).toMatchObject({
      isCheckedOut: true,
      checkedOutById: "user-1",
    });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        userId: "user-1",
        action: "file.checkout",
        entityId: FILE_ID,
      })
    );
  });
});
