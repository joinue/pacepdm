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
    range?: { from: number; to: number };
    countMode?: string;
    order?: { column: string; ascending?: boolean };
    orders?: Array<{ column: string; ascending?: boolean }>;
  };

  const tableResults: Record<string, { data: unknown; error: unknown; count?: number }> = {};
  const lastQuery: Query = {};

  function makeChain(table: string) {
    lastQuery.table = table;
    const chain: Record<string, (...args: unknown[]) => unknown> = {};

    const resolvable = () => tableResults[table] ?? { data: null, error: null, count: 0 };

    for (const m of ["select", "eq", "in", "is", "not", "order", "limit", "range"] as const) {
      chain[m] = (...args: unknown[]) => {
        if (m === "select")
          lastQuery.countMode = (args[1] as { count?: string } | undefined)?.count;
        if (m === "eq" && args[0] === "tenantId") lastQuery.tenantId = args[1];
        if (m === "not" && args[0] === "deletedAt") lastQuery.deletedState = "notNull";
        if (m === "is" && args[0] === "deletedAt" && args[1] === null)
          lastQuery.deletedState = "null";
        if (m === "limit") lastQuery.limit = args[0] as number;
        if (m === "range") lastQuery.range = { from: args[0] as number, to: args[1] as number };
        if (m === "order") {
          const entry = {
            column: args[0] as string,
            ascending: (args[1] as { ascending?: boolean } | undefined)?.ascending,
          };
          // First order() wins for `order`; `orders` keeps the full sequence,
          // because the tie-break on id is what makes paging stable across a
          // bulk delete that stamped every row with the same timestamp.
          if (!lastQuery.order) lastQuery.order = entry;
          (lastQuery.orders ??= []).push(entry);
        }
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

function makeRequest(search = ""): NextRequest {
  return new NextRequest(`http://localhost/api/files/deleted${search}`);
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
  lastQuery.orders = undefined;
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
    tableResults["files"] = { data: rows, error: null, count: 2 };

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    expect(lastQuery.table).toBe("files");
    expect(lastQuery.tenantId).toBe("tenant-1");
    expect(lastQuery.deletedState).toBe("notNull");
    expect(lastQuery.order).toEqual({ column: "deletedAt", ascending: false });
  });

  /**
   * A bulk delete stamps every file in the batch with the same `deletedAt`.
   * Without a tie-break the order of those rows is undefined between requests,
   * so a row can appear on two pages or on none.
   */
  it("breaks ties on id so paging is stable across a bulk delete", async () => {
    mockTenantUser.current = engineer;
    tableResults["files"] = { data: rows, error: null, count: 2 };
    await GET(makeRequest());
    expect(lastQuery.orders).toEqual([
      { column: "deletedAt", ascending: false },
      { column: "id", ascending: false },
    ]);
  });

  it("drops files in folders the caller cannot view", async () => {
    mockTenantUser.current = engineer;
    tableResults["files"] = { data: rows, error: null, count: 2 };
    mockScope.visibleFolders = ["folder-1"];

    const body = await (await GET(makeRequest())).json();
    expect(body.files.map((f: { id: string }) => f.id)).toEqual(["f1"]);
  });

  it("returns an empty list rather than null when the trash is empty", async () => {
    mockTenantUser.current = engineer;
    tableResults["files"] = { data: null, error: null, count: 0 };

    const body = await (await GET(makeRequest())).json();
    expect(body.files).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.hasMore).toBe(false);
  });
});

/**
 * The listing used to be a flat 200-row cap with no way past it. Nothing
 * purges the trash — deliberately — so past 200 deletions the oldest rows sat
 * in the database and vanished from the UI: invisible, un-restorable and
 * un-deletable through any supported route. A cap that hides data is worse
 * than no cap, because it looks like the data is gone.
 */
describe("GET /api/files/deleted — paging", () => {
  beforeEach(() => {
    mockTenantUser.current = engineer;
  });

  it("requests the first page by default", async () => {
    tableResults["files"] = { data: rows, error: null, count: 2 };
    await GET(makeRequest());
    expect(lastQuery.range).toEqual({ from: 0, to: 99 });
  });

  it("honours an explicit offset", async () => {
    tableResults["files"] = { data: rows, error: null, count: 500 };
    await GET(makeRequest("?offset=300"));
    expect(lastQuery.range).toEqual({ from: 300, to: 399 });
  });

  it("honours an explicit limit", async () => {
    tableResults["files"] = { data: rows, error: null, count: 500 };
    await GET(makeRequest("?limit=25&offset=50"));
    expect(lastQuery.range).toEqual({ from: 50, to: 74 });
  });

  it("refuses a limit above the maximum rather than silently clamping", async () => {
    tableResults["files"] = { data: rows, error: null, count: 500 };
    expect((await GET(makeRequest("?limit=5000"))).status).toBe(400);
  });

  it("refuses a negative offset", async () => {
    tableResults["files"] = { data: rows, error: null, count: 500 };
    expect((await GET(makeRequest("?offset=-1"))).status).toBe(400);
  });

  it("asks for an exact count so the UI can say how many are hidden", async () => {
    tableResults["files"] = { data: rows, error: null, count: 412 };
    const body = await (await GET(makeRequest())).json();
    expect(lastQuery.countMode).toBe("exact");
    expect(body.total).toBe(412);
  });

  it("reports more pages when the count exceeds what was returned", async () => {
    tableResults["files"] = { data: rows, error: null, count: 412 };
    const body = await (await GET(makeRequest())).json();
    expect(body.hasMore).toBe(true);
  });

  it("reports no more pages on the last one", async () => {
    tableResults["files"] = { data: rows, error: null, count: 2 };
    const body = await (await GET(makeRequest())).json();
    expect(body.hasMore).toBe(false);
  });

  /**
   * `hasMore` is computed from the pre-ACL row count, not from the filtered
   * list. A page where every row is filtered out by folder access would
   * otherwise report the end of the list and strand everything after it.
   */
  it("keeps paging when the ACL filter empties an entire page", async () => {
    tableResults["files"] = { data: rows, error: null, count: 412 };
    mockScope.visibleFolders = []; // sees nothing
    const body = await (await GET(makeRequest())).json();
    expect(body.files).toEqual([]);
    expect(body.hasMore).toBe(true);
  });

  it("echoes the offset and limit it used", async () => {
    tableResults["files"] = { data: rows, error: null, count: 412 };
    const body = await (await GET(makeRequest("?offset=100&limit=50"))).json();
    expect(body).toMatchObject({ offset: 100, limit: 50 });
  });
});
