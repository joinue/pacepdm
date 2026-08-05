import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The trash listing has two jobs beyond returning rows: it must ask only for
 * deleted rows, and it must drop files in folders the caller cannot see. The
 * mock records the `.not("deletedAt", ...)` filter so the first is observable,
 * and the ACL scope is driven per-test so the second is a real filter rather
 * than a stub returning whatever it was given.
 */

const { tableResults, lastQuery, mockFrom } = vi.hoisted(() => {
  type Query = {
    table?: string;
    tenantId?: unknown;
    deletedState?: "null" | "notNull";
    limit?: number;
    order?: { column: string; ascending?: boolean };
  };

  const tableResults: Record<string, { data: unknown; error: unknown }> = {};
  const lastQuery: Query = {};

  function makeChain(table: string) {
    lastQuery.table = table;
    const chain: Record<string, (...args: unknown[]) => unknown> = {};

    const resolvable = () => tableResults[table] ?? { data: null, error: null };

    for (const m of ["select", "eq", "in", "is", "not", "order", "limit"] as const) {
      chain[m] = (...args: unknown[]) => {
        if (m === "eq" && args[0] === "tenantId") lastQuery.tenantId = args[1];
        if (m === "not" && args[0] === "deletedAt") lastQuery.deletedState = "notNull";
        if (m === "is" && args[0] === "deletedAt" && args[1] === null)
          lastQuery.deletedState = "null";
        if (m === "limit") lastQuery.limit = args[0] as number;
        if (m === "order")
          lastQuery.order = {
            column: args[0] as string,
            ascending: (args[1] as { ascending?: boolean } | undefined)?.ascending,
          };
        return chain;
      };
    }

    chain.then = ((resolve: (v: unknown) => void) => resolve(resolvable())) as unknown as (
      ...args: unknown[]
    ) => unknown;

    return chain;
  }

  return { tableResults, lastQuery, mockFrom: (table: string) => makeChain(table) };
});

const mockTenantUser = vi.hoisted(() => ({
  current: null as {
    id: string;
    tenantId: string;
    fullName: string;
    role: { permissions: string[] };
  } | null,
}));

const mockScope = vi.hoisted(() => ({ visibleFolders: null as string[] | null }));

vi.mock("@/lib/db", () => ({
  getServiceClient: () => ({ from: mockFrom }),
}));

vi.mock("@/lib/auth", () => ({
  getApiTenantUser: () => Promise.resolve(mockTenantUser.current),
}));

vi.mock("@/lib/folder-access", async () => {
  const actual = await vi.importActual<typeof import("@/lib/folder-access")>("@/lib/folder-access");
  return {
    ...actual,
    // `restrictedAny: true` is what makes `allowed` authoritative — with it
    // false, `canViewFolder` treats an unlisted folder as visible.
    getFolderAccessScope: vi.fn(async () =>
      mockScope.visibleFolders === null
        ? actual.openScope()
        : {
            ...actual.openScope(),
            restrictedAny: true,
            allowed: new Set(mockScope.visibleFolders),
          }
    ),
  };
});

import { GET } from "./route";

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost/api/files/deleted");
}

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

const rows = [
  { id: "f1", name: "bracket.sldprt", folderId: "folder-1", deletedAt: "2026-08-02T00:00:00Z" },
  {
    id: "f2",
    name: "housing.step",
    folderId: "folder-restricted",
    deletedAt: "2026-08-01T00:00:00Z",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockScope.visibleFolders = null;
  for (const key of Object.keys(tableResults)) delete tableResults[key];
  for (const key of Object.keys(lastQuery)) delete (lastQuery as Record<string, unknown>)[key];
});

describe("GET /api/files/deleted", () => {
  it("returns 401 when not authenticated", async () => {
    mockTenantUser.current = null;
    expect((await GET(makeRequest())).status).toBe(401);
  });

  it("returns 403 without FILE_DELETE permission", async () => {
    mockTenantUser.current = viewer;
    expect((await GET(makeRequest())).status).toBe(403);
  });

  it("asks only for deleted rows, scoped to the caller's tenant, newest first", async () => {
    mockTenantUser.current = engineer;
    tableResults["files"] = { data: rows, error: null };

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    expect(lastQuery.table).toBe("files");
    expect(lastQuery.tenantId).toBe("tenant-1");
    expect(lastQuery.deletedState).toBe("notNull");
    expect(lastQuery.order).toEqual({ column: "deletedAt", ascending: false });
    expect(lastQuery.limit).toBe(200);
  });

  it("drops files in folders the caller cannot view", async () => {
    mockTenantUser.current = engineer;
    tableResults["files"] = { data: rows, error: null };
    mockScope.visibleFolders = ["folder-1"];

    const body = await (await GET(makeRequest())).json();
    expect(body.map((f: { id: string }) => f.id)).toEqual(["f1"]);
  });

  it("returns an empty list rather than null when the trash is empty", async () => {
    mockTenantUser.current = engineer;
    tableResults["files"] = { data: null, error: null };

    const body = await (await GET(makeRequest())).json();
    expect(body).toEqual([]);
  });
});
