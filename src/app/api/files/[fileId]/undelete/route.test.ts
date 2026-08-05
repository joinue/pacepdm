import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Undelete is the only path that deliberately reads soft-deleted rows, so the
 * mock has to distinguish "deleted" from "live" queries rather than serving
 * one fixed row. It records the `.is()` / `.not()` filter on `deletedAt`
 * alongside the `.eq()` filters, which is what makes two cases real tests
 * rather than tautologies:
 *
 *   - a live file must 404 — the route's `.not("deletedAt", "is", null)`
 *     filter is what produces that, and a mock ignoring it would pass either
 *     way, exactly the flaw the route-wrapper conversion found in the older
 *     file tests;
 *   - the name-collision check queries live rows only, so it must not match
 *     the deleted row it is about to restore.
 */

const { tableResults, updateCalls, mockFrom, FILE_ID } = vi.hoisted(() => {
  const FILE_ID_CONST = "33333333-3333-4333-8333-333333333333";
  type Filters = Record<string, unknown> & { deletedState?: "null" | "notNull" };
  type QueryResult = { data: unknown; error: unknown };
  type Handler = QueryResult | ((filters: Filters) => QueryResult);

  const tableResults: Record<string, Handler> = {};
  const updateCalls: Array<{ table: string; data: unknown; filters: Filters }> = [];

  function makeChain(table: string) {
    const filters: Filters = {};
    const chain: Record<string, (...args: unknown[]) => unknown> = {};

    const resolvable = (): QueryResult => {
      const handler = tableResults[table];
      if (typeof handler === "function") return handler(filters);
      return handler ?? { data: null, error: null };
    };

    for (const m of ["select", "eq", "in", "neq", "is", "not", "order", "limit"] as const) {
      chain[m] = (...args: unknown[]) => {
        if (m === "eq" && args.length === 2) filters[args[0] as string] = args[1];
        // `.is("deletedAt", null)` → live rows only.
        if (m === "is" && args[0] === "deletedAt" && args[1] === null)
          filters.deletedState = "null";
        // `.not("deletedAt", "is", null)` → deleted rows only.
        if (m === "not" && args[0] === "deletedAt") filters.deletedState = "notNull";
        return chain;
      };
    }

    chain.single = () => resolvable();
    chain.maybeSingle = () => resolvable();

    chain.update = (data: unknown) => {
      updateCalls.push({ table, data, filters: { ...filters } });
      const updateChain: Record<string, (...args: unknown[]) => unknown> = {};
      for (const m of ["eq", "select"] as const) updateChain[m] = () => updateChain;
      updateChain.single = () => ({
        data: { id: FILE_ID_CONST, deletedAt: null, name: "bracket.sldprt" },
        error: null,
      });
      return updateChain;
    };

    chain.then = ((resolve: (v: unknown) => void) => resolve(resolvable())) as unknown as (
      ...args: unknown[]
    ) => unknown;

    return chain;
  }

  return {
    tableResults,
    updateCalls,
    FILE_ID: FILE_ID_CONST,
    mockFrom: (table: string) => makeChain(table),
  };
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

// Only the scope resolver is stubbed; `loadDeletedFile` runs for real so its
// tenant filter and folder gate are under test.
vi.mock("@/lib/folder-access", async () => {
  const actual = await vi.importActual<typeof import("@/lib/folder-access")>("@/lib/folder-access");
  return { ...actual, getFolderAccessScope: vi.fn(async () => actual.openScope()) };
});

import { POST } from "./route";
import { logAudit } from "@/lib/audit";

function makeRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/files/${FILE_ID}/undelete`, { method: "POST" });
}

const params = Promise.resolve({ fileId: FILE_ID });

const engineer = {
  id: "user-1",
  tenantId: "tenant-1",
  fullName: "Alice",
  role: { permissions: ["file.delete"] },
};

const viewer = {
  id: "user-2",
  tenantId: "tenant-1",
  fullName: "Bob",
  role: { permissions: ["file.view"] },
};

const deletedFile = {
  id: FILE_ID,
  tenantId: "tenant-1",
  name: "bracket.sldprt",
  folderId: "folder-1",
  deletedAt: "2026-08-01T10:00:00.000Z",
  deletedById: "user-9",
};

/**
 * Serve the trash row only to its owning tenant and only to a query that
 * actually asked for deleted rows. `nameHolder` is the live file occupying
 * the same name, if the case wants one.
 */
function vaultState(options: {
  owner?: string;
  file?: Record<string, unknown> | null;
  nameHolder?: Record<string, unknown> | null;
}) {
  const { owner = "tenant-1", file = deletedFile, nameHolder = null } = options;
  tableResults["files"] = (filters) => {
    if (filters.tenantId !== owner) return { data: null, error: null };
    if (filters.deletedState === "notNull") return { data: file, error: null };
    if (filters.deletedState === "null") return { data: nameHolder, error: null };
    return { data: null, error: null };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  updateCalls.length = 0;
  for (const key of Object.keys(tableResults)) delete tableResults[key];
});

describe("POST /api/files/[fileId]/undelete", () => {
  it("returns 401 when not authenticated", async () => {
    mockTenantUser.current = null;
    expect((await POST(makeRequest(), { params })).status).toBe(401);
  });

  it("returns 403 without FILE_DELETE permission", async () => {
    mockTenantUser.current = viewer;
    vaultState({});
    expect((await POST(makeRequest(), { params })).status).toBe(403);
  });

  it("returns 400 for a malformed file id, before touching the database", async () => {
    mockTenantUser.current = engineer;
    const res = await POST(makeRequest(), { params: Promise.resolve({ fileId: "file-1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a deleted file in another tenant", async () => {
    mockTenantUser.current = engineer;
    vaultState({ owner: "tenant-OTHER" });
    expect((await POST(makeRequest(), { params })).status).toBe(404);
  });

  it("returns 404 for a file that is not deleted", async () => {
    mockTenantUser.current = engineer;
    vaultState({ file: null });
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(404);
    expect(updateCalls.length).toBe(0);
  });

  it("returns 409 when a live file has taken the name, and does not restore", async () => {
    mockTenantUser.current = engineer;
    vaultState({ nameHolder: { id: "other-file", name: "bracket.sldprt" } });
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/another file named/i);
    expect(updateCalls.length).toBe(0);
  });

  it("clears deletedAt and deletedById, and logs audit", async () => {
    mockTenantUser.current = engineer;
    vaultState({});
    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(200);

    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].table).toBe("files");
    expect(updateCalls[0].data).toMatchObject({ deletedAt: null, deletedById: null });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        userId: "user-1",
        action: "file.undelete",
        entityId: FILE_ID,
      })
    );
  });
});
