import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The count has to agree with `/api/approvals` or the badge lies. The cases
 * that matter are the two filters that are easy to drop: membership scoping
 * (a user with no groups counts nothing) and the parent-request check (a
 * PENDING decision under a non-PENDING request must not count).
 *
 * The mock records the filters applied rather than returning a fixed number,
 * so a route that forgot one of them fails here.
 */
const { tableResults, selectCalls, filterCalls, mockFrom } = vi.hoisted(() => {
  type QueryResult = { data?: unknown; count?: number | null; error: unknown };
  type Handler = QueryResult | ((filters: Record<string, unknown>) => QueryResult);

  const tableResults: Record<string, Handler> = {};
  const selectCalls: Array<{ table: string; columns: string; options: unknown }> = [];
  const filterCalls: Array<{ table: string; method: string; args: unknown[] }> = [];

  function makeChain(table: string) {
    const filters: Record<string, unknown> = {};
    const chain: Record<string, (...args: unknown[]) => unknown> = {};

    const resolvable = (): QueryResult => {
      const handler = tableResults[table];
      if (typeof handler === "function") return handler(filters);
      return handler ?? { data: null, count: null, error: null };
    };

    chain.select = (...args: unknown[]) => {
      selectCalls.push({ table, columns: String(args[0] ?? ""), options: args[1] });
      return chain;
    };

    for (const m of ["eq", "in", "neq", "is", "order", "limit"] as const) {
      chain[m] = (...args: unknown[]) => {
        filterCalls.push({ table, method: m, args });
        if (args.length === 2) filters[args[0] as string] = args[1];
        return chain;
      };
    }

    chain.single = () => resolvable();
    chain.maybeSingle = () => resolvable();
    chain.then = ((resolve: (v: unknown) => void) => resolve(resolvable())) as unknown as (
      ...args: unknown[]
    ) => unknown;

    return chain;
  }

  return {
    tableResults,
    selectCalls,
    filterCalls,
    mockFrom: (table: string) => makeChain(table),
  };
});

const mockTenantUser = vi.hoisted(() => ({
  current: null as {
    id: string;
    tenantId: string;
    role: { permissions: string[] };
  } | null,
}));

vi.mock("@/lib/db", () => ({ getServiceClient: () => ({ from: mockFrom }) }));
vi.mock("@/lib/auth", () => ({
  getApiTenantUser: () => Promise.resolve(mockTenantUser.current),
}));

import { GET } from "./route";

const reviewer = {
  id: "user-1",
  tenantId: "tenant-1",
  role: { permissions: [] },
};

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost/api/approvals/count");
}

const ctx = { params: Promise.resolve({}) };

beforeEach(() => {
  vi.clearAllMocks();
  selectCalls.length = 0;
  filterCalls.length = 0;
  for (const k of Object.keys(tableResults)) delete tableResults[k];
  mockTenantUser.current = reviewer;
});

describe("GET /api/approvals/count", () => {
  it("401s without a session", async () => {
    mockTenantUser.current = null;

    const res = await GET(makeRequest(), ctx);

    expect(res.status).toBe(401);
  });

  it("returns zero without querying decisions when the user is in no groups", async () => {
    tableResults["approval_group_members"] = { data: [], error: null };

    const res = await GET(makeRequest(), ctx);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ count: 0 });
    expect(selectCalls.some((c) => c.table === "approval_decisions")).toBe(false);
  });

  it("counts only the caller's groups", async () => {
    tableResults["approval_group_members"] = {
      data: [{ groupId: "g1" }, { groupId: "g2" }],
      error: null,
    };
    tableResults["approval_decisions"] = { count: 3, error: null };

    const res = await GET(makeRequest(), ctx);

    await expect(res.json()).resolves.toEqual({ count: 3 });

    const groupFilter = filterCalls.find(
      (c) => c.table === "approval_decisions" && c.method === "in"
    );
    expect(groupFilter?.args).toEqual(["groupId", ["g1", "g2"]]);
  });

  it("asks for a head-only exact count rather than rows", async () => {
    tableResults["approval_group_members"] = { data: [{ groupId: "g1" }], error: null };
    tableResults["approval_decisions"] = { count: 1, error: null };

    await GET(makeRequest(), ctx);

    const call = selectCalls.find((c) => c.table === "approval_decisions");
    expect(call?.options).toEqual({ count: "exact", head: true });
  });

  it("excludes decisions whose parent request is no longer pending", async () => {
    tableResults["approval_group_members"] = { data: [{ groupId: "g1" }], error: null };
    tableResults["approval_decisions"] = { count: 0, error: null };

    await GET(makeRequest(), ctx);

    const decisionFilters = filterCalls.filter((c) => c.table === "approval_decisions");
    // The decision itself must be pending...
    expect(decisionFilters).toContainEqual(
      expect.objectContaining({ method: "eq", args: ["status", "PENDING"] })
    );
    // ...and so must the request it hangs off, via the inner join.
    expect(decisionFilters).toContainEqual(
      expect.objectContaining({ method: "eq", args: ["request.status", "PENDING"] })
    );
    const call = selectCalls.find((c) => c.table === "approval_decisions");
    expect(call?.columns).toContain("!inner");
  });

  it("treats a null count as zero", async () => {
    tableResults["approval_group_members"] = { data: [{ groupId: "g1" }], error: null };
    tableResults["approval_decisions"] = { count: null, error: null };

    const res = await GET(makeRequest(), ctx);

    await expect(res.json()).resolves.toEqual({ count: 0 });
  });

  it("surfaces a database error rather than reporting zero", async () => {
    tableResults["approval_group_members"] = { data: [{ groupId: "g1" }], error: null };
    tableResults["approval_decisions"] = { count: null, error: { message: "boom" } };

    const res = await GET(makeRequest(), ctx);

    expect(res.status).toBe(500);
  });
});
