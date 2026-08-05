import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The roles list drives an admin screen that decides whether a role can be
 * deleted, so the user count it reports has to agree with what DELETE
 * /api/roles/[roleId] actually enforces. The two ways to get that wrong are
 * counting the wrong rows (filtering to active users, when the delete guard
 * does not) and counting them per-role in a way that misattributes.
 *
 * The mock records the filters applied rather than returning fixed rows, so a
 * route that added an `isActive` filter fails here.
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
vi.mock("@/lib/audit", () => ({ logAudit: () => Promise.resolve() }));

import { GET } from "./route";

const viewer = {
  id: "user-1",
  tenantId: "tenant-1",
  role: { permissions: ["file.view"] },
};

const roleAdmin = {
  id: "user-2",
  tenantId: "tenant-1",
  role: { permissions: ["admin.roles"] },
};

const userAdmin = {
  id: "user-3",
  tenantId: "tenant-1",
  role: { permissions: ["admin.users"] },
};

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost/api/roles");
}

const ctx = { params: Promise.resolve({}) };

const ROLES = [
  {
    id: "role-admin",
    name: "Admin",
    description: "Full system access",
    permissions: ["*"],
    isSystem: true,
  },
  {
    id: "role-manager",
    name: "Manager",
    description: "Approve changes",
    permissions: ["file.view", "audit.view"],
    isSystem: true,
  },
  {
    id: "role-custom",
    name: "Contractor",
    description: null,
    permissions: [],
    isSystem: false,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  selectCalls.length = 0;
  filterCalls.length = 0;
  for (const k of Object.keys(tableResults)) delete tableResults[k];
  mockTenantUser.current = roleAdmin;
});

describe("GET /api/roles", () => {
  it("401s without a session", async () => {
    mockTenantUser.current = null;

    const res = await GET(makeRequest(), ctx);

    expect(res.status).toBe(401);
  });

  it("attaches the number of users holding each role", async () => {
    tableResults["roles"] = { data: ROLES, error: null };
    tableResults["tenant_users"] = {
      data: [
        { roleId: "role-admin" },
        { roleId: "role-manager" },
        { roleId: "role-manager" },
        { roleId: "role-manager" },
      ],
      error: null,
    };

    const res = await GET(makeRequest(), ctx);
    const body = (await res.json()) as Array<{ id: string; userCount: number }>;

    expect(res.status).toBe(200);
    expect(Object.fromEntries(body.map((r) => [r.id, r.userCount]))).toEqual({
      "role-admin": 1,
      "role-manager": 3,
      "role-custom": 0,
    });
  });

  it("counts deactivated users too, matching the delete guard", async () => {
    // DELETE /api/roles/[roleId] refuses on any tenant_users row holding the
    // role, active or not. Reporting 0 here beside an enabled delete button
    // would produce a 409 the admin screen said could not happen.
    tableResults["roles"] = { data: ROLES, error: null };
    tableResults["tenant_users"] = { data: [], error: null };

    await GET(makeRequest(), ctx);

    const userFilters = filterCalls.filter((c) => c.table === "tenant_users");
    expect(userFilters.some((c) => c.args[0] === "isActive")).toBe(false);
  });

  it("scopes both queries to the caller's tenant", async () => {
    tableResults["roles"] = { data: ROLES, error: null };
    tableResults["tenant_users"] = { data: [], error: null };

    await GET(makeRequest(), ctx);

    for (const table of ["roles", "tenant_users"]) {
      expect(
        filterCalls.some((c) => c.table === table && c.method === "eq" && c.args[0] === "tenantId"),
        `${table} was not tenant-scoped`
      ).toBe(true);
    }
  });

  it("ignores rows with no role assigned", async () => {
    tableResults["roles"] = { data: ROLES, error: null };
    tableResults["tenant_users"] = {
      data: [{ roleId: null }, { roleId: "role-custom" }],
      error: null,
    };

    const res = await GET(makeRequest(), ctx);
    const body = (await res.json()) as Array<{ id: string; userCount: number }>;

    expect(body.find((r) => r.id === "role-custom")?.userCount).toBe(1);
  });

  it("returns an empty list rather than throwing when there are no roles", async () => {
    tableResults["roles"] = { data: null, error: null };

    const res = await GET(makeRequest(), ctx);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([]);
    expect(selectCalls.some((c) => c.table === "tenant_users")).toBe(false);
  });

  // The folder access dialog and the SSO screen need role names for callers
  // who do not administer roles, so this route stays readable. What it must
  // not leak to them is the shape of the tenant's authorisation model.
  describe("detail level", () => {
    beforeEach(() => {
      tableResults["roles"] = { data: ROLES, error: null };
      tableResults["tenant_users"] = { data: [{ roleId: "role-admin" }], error: null };
    });

    it("gives a plain user names without permissions or counts", async () => {
      mockTenantUser.current = viewer;

      const res = await GET(makeRequest(), ctx);
      const body = (await res.json()) as Array<Record<string, unknown>>;

      expect(res.status).toBe(200);
      expect(body).toHaveLength(3);
      for (const role of body) {
        expect(Object.keys(role).sort()).toEqual(["description", "id", "name"]);
      }
    });

    it("does not even count users for a caller who cannot see counts", async () => {
      mockTenantUser.current = viewer;

      await GET(makeRequest(), ctx);

      expect(selectCalls.some((c) => c.table === "tenant_users")).toBe(false);
    });

    it("gives a role administrator the full record", async () => {
      mockTenantUser.current = roleAdmin;

      const res = await GET(makeRequest(), ctx);
      const body = (await res.json()) as Array<Record<string, unknown>>;

      expect(body[0]).toHaveProperty("permissions");
      expect(body[0]).toHaveProperty("userCount");
    });

    it("gives a user administrator the full record too", async () => {
      // Assigning someone a role without being able to see what it grants
      // is how over-privileging happens.
      mockTenantUser.current = userAdmin;

      const res = await GET(makeRequest(), ctx);
      const body = (await res.json()) as Array<Record<string, unknown>>;

      expect(body[0]).toHaveProperty("permissions");
      expect(body[0]).toHaveProperty("userCount");
    });
  });
});
