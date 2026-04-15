import { describe, it, expect, vi, beforeEach } from "vitest";

// Table-routed mock builder. Each test sets `tableResults` to control what
// individual queries return, mirroring the pattern used in approval-engine.test.
// The `tenant_users:byEmail` special key lets a test target the adoption
// lookup (by tenantId+email) distinct from the preexisting-by-authUserId
// lookup — the two queries hit the same table but need different fixtures.
const { tableResults, insertCalls, updateCalls, mockFrom } = vi.hoisted(() => {
  type QueryResult = { data: unknown; error: unknown };

  const tableResults: Record<string, QueryResult> = {};
  const insertCalls: Array<{ table: string; data: unknown }> = [];
  const updateCalls: Array<{ table: string; data: unknown }> = [];

  function makeChain(table: string) {
    const filters: Record<string, unknown> = {};
    const chain: Record<string, (...args: unknown[]) => unknown> = {};

    function resolvable() {
      if (table === "tenant_users" && filters.email !== undefined) {
        return tableResults["tenant_users:byEmail"] || { data: null, error: null };
      }
      return tableResults[table] || { data: null, error: null };
    }

    for (const m of ["select", "eq", "in", "neq", "is", "order", "limit"] as const) {
      chain[m] = (...args: unknown[]) => {
        if (m === "eq" && args.length === 2) filters[args[0] as string] = args[1];
        return chain;
      };
    }

    chain.single = () => resolvable();
    chain.maybeSingle = () => resolvable();

    chain.insert = (data: unknown) => {
      insertCalls.push({ table, data });
      const err = tableResults[`${table}:insert`];
      return Promise.resolve(err || { data: null, error: null });
    };

    chain.update = (data: unknown) => {
      updateCalls.push({ table, data });
      const updateChain: Record<string, (...args: unknown[]) => unknown> = {};
      for (const m of ["eq", "in"] as const) {
        updateChain[m] = () => updateChain;
      }
      updateChain.then = ((resolve: (v: unknown) => void) =>
        resolve({ data: null, error: null })) as unknown as (...args: unknown[]) => unknown;
      return updateChain;
    };

    chain.then = ((resolve: (v: unknown) => void) => resolve(resolvable())) as unknown as (
      ...args: unknown[]
    ) => unknown;

    return chain;
  }

  return {
    tableResults,
    insertCalls,
    updateCalls,
    mockFrom: (table: string) => makeChain(table),
  };
});

vi.mock("@/lib/db", () => ({
  getServiceClient: () => ({ from: mockFrom }),
}));

vi.mock("uuid", () => ({ v4: () => "mock-uuid" }));

import { jitProvisionSsoUser, emailDomain } from "./sso-jit";

beforeEach(() => {
  vi.clearAllMocks();
  insertCalls.length = 0;
  updateCalls.length = 0;
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

  it("adopts an existing tenant_users row when the email already exists in the SSO tenant", async () => {
    // Active SSO mapping
    tableResults.tenant_sso_domains = {
      data: { tenantId: "tenant-1", jitRoleId: "role-1" },
      error: null,
    };
    // No row keyed on the (new) authUserId — Alice's existing row was
    // created by password auth with a different authUserId.
    tableResults.tenant_users = { data: null, error: null };
    // But there IS a row keyed on (tenantId, email) — the legacy one.
    tableResults["tenant_users:byEmail"] = {
      data: { id: "legacy-row-id", tenantId: "tenant-1" },
      error: null,
    };

    const result = await jitProvisionSsoUser({
      authUserId: "new-sso-auth-id",
      email: "alice@acme.com",
      metadata: undefined,
    });

    expect(result).toEqual({ tenantId: "tenant-1", tenantUserId: "legacy-row-id" });

    // No new row inserted — we adopted.
    expect(insertCalls.filter((c) => c.table === "tenant_users")).toHaveLength(0);

    // The existing row's authUserId was rewritten to the SAML identity.
    const update = updateCalls.find((c) => c.table === "tenant_users");
    expect(update).toBeDefined();
    const data = update!.data as Record<string, unknown>;
    expect(data.authUserId).toBe("new-sso-auth-id");
    expect(data.ssoProvisioned).toBe(true);
    expect(typeof data.lastSsoLoginAt).toBe("string");
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
