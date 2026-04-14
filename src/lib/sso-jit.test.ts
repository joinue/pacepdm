import { describe, it, expect, vi, beforeEach } from "vitest";

// Table-routed mock builder. Each test sets `tableResults` to control what
// individual queries return, mirroring the pattern used in approval-engine.test.
const { tableResults, insertCalls, mockFrom } = vi.hoisted(() => {
  type QueryResult = { data: unknown; error: unknown };

  const tableResults: Record<string, QueryResult> = {};
  const insertCalls: Array<{ table: string; data: unknown }> = [];

  function makeChain(table: string) {
    const chain: Record<string, (...args: unknown[]) => unknown> = {};

    const resolvable = () => tableResults[table] || { data: null, error: null };

    for (const m of ["select", "eq", "in", "neq", "is", "order", "limit"] as const) {
      chain[m] = () => chain;
    }

    chain.single = () => resolvable();
    chain.maybeSingle = () => resolvable();

    chain.insert = (data: unknown) => {
      insertCalls.push({ table, data });
      const err = tableResults[`${table}:insert`];
      return Promise.resolve(err || { data: null, error: null });
    };

    chain.then = ((resolve: (v: unknown) => void) => resolve(resolvable())) as unknown as (
      ...args: unknown[]
    ) => unknown;

    return chain;
  }

  return { tableResults, insertCalls, mockFrom: (table: string) => makeChain(table) };
});

vi.mock("@/lib/db", () => ({
  getServiceClient: () => ({ from: mockFrom }),
}));

vi.mock("uuid", () => ({ v4: () => "mock-uuid" }));

import { jitProvisionSsoUser, emailDomain } from "./sso-jit";

beforeEach(() => {
  vi.clearAllMocks();
  insertCalls.length = 0;
  for (const k of Object.keys(tableResults)) delete tableResults[k];
});

describe("emailDomain", () => {
  it("extracts the lowercased domain from an email", () => {
    expect(emailDomain("Alice@Acme.com")).toBe("acme.com");
    expect(emailDomain("user@sub.example.io")).toBe("sub.example.io");
  });

  it("returns null for invalid input", () => {
    expect(emailDomain("no-at-sign")).toBeNull();
    expect(emailDomain("user@")).toBeNull();
    expect(emailDomain("")).toBeNull();
  });
});

describe("jitProvisionSsoUser", () => {
  it("returns null when the email domain has no mapping", async () => {
    tableResults.tenant_sso_domains = { data: null, error: null };

    const result = await jitProvisionSsoUser({
      authUserId: "auth-1",
      email: "alice@acme.com",
      metadata: undefined,
    });

    expect(result).toBeNull();
    expect(insertCalls.filter((c) => c.table === "tenant_users")).toHaveLength(0);
  });

  it("creates a tenant_users row when the domain is registered", async () => {
    tableResults.tenant_sso_domains = {
      data: { tenantId: "tenant-1", jitRoleId: "role-1" },
      error: null,
    };
    tableResults.tenant_users = { data: null, error: null };

    const result = await jitProvisionSsoUser({
      authUserId: "auth-1",
      email: "alice@acme.com",
      metadata: { full_name: "Alice Admin" },
    });

    expect(result).toEqual({ tenantId: "tenant-1", tenantUserId: "mock-uuid" });

    const insert = insertCalls.find((c) => c.table === "tenant_users");
    expect(insert).toBeDefined();
    const data = insert!.data as Record<string, unknown>;
    expect(data.tenantId).toBe("tenant-1");
    expect(data.authUserId).toBe("auth-1");
    expect(data.email).toBe("alice@acme.com");
    expect(data.fullName).toBe("Alice Admin");
    expect(data.roleId).toBe("role-1");
    expect(data.ssoProvisioned).toBe(true);
  });

  it("short-circuits when a tenant_users row already exists for the auth user", async () => {
    tableResults.tenant_sso_domains = {
      data: { tenantId: "tenant-1", jitRoleId: "role-1" },
      error: null,
    };
    tableResults.tenant_users = {
      data: { id: "existing-1", tenantId: "tenant-other" },
      error: null,
    };

    const result = await jitProvisionSsoUser({
      authUserId: "auth-1",
      email: "alice@acme.com",
      metadata: undefined,
    });

    // Existing row wins — block semantics. No insert attempted.
    expect(result).toEqual({ tenantId: "tenant-other", tenantUserId: "existing-1" });
    expect(insertCalls.filter((c) => c.table === "tenant_users")).toHaveLength(0);
  });

  it("infers a name from the email local part when metadata is empty", async () => {
    tableResults.tenant_sso_domains = {
      data: { tenantId: "tenant-1", jitRoleId: "role-1" },
      error: null,
    };
    tableResults.tenant_users = { data: null, error: null };

    await jitProvisionSsoUser({
      authUserId: "auth-1",
      email: "alice@acme.com",
      metadata: undefined,
    });

    const insert = insertCalls.find((c) => c.table === "tenant_users")!;
    const data = insert.data as Record<string, unknown>;
    expect(data.fullName).toBe("alice");
  });
});
