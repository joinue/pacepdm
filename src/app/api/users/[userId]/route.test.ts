import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Reactivation and the one-active-membership rule.
 *
 * Sign-in resolves the caller with `.single()` over their active memberships.
 * Reactivating someone who had joined another workspace in the meantime gave
 * them two active rows, so they resolved to no workspace at all — and
 * onboarding offered to create a third.
 */

const { rows, updates, mockFrom } = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const rows: Record<string, Row[]> = {};
  const updates: { table: string; values: Row }[] = [];

  function makeChain(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let pendingUpdate: Row | null = null;
    const matched = () => (rows[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    for (const m of ["select", "order", "limit", "is"] as const) chain[m] = () => chain;
    chain.eq = (col: unknown, val: unknown) => {
      filters.push((r) => r[col as string] === val);
      return chain;
    };
    chain.neq = (col: unknown, val: unknown) => {
      filters.push((r) => r[col as string] !== val);
      return chain;
    };
    chain.in = (col: unknown, vals: unknown) => {
      filters.push((r) => (vals as unknown[]).includes(r[col as string]));
      return chain;
    };
    chain.single = () => ({ data: matched()[0] ?? null, error: null });
    chain.maybeSingle = () => ({ data: matched()[0] ?? null, error: null });
    chain.update = (values: unknown) => {
      pendingUpdate = values as Row;
      return chain;
    };
    chain.then = ((resolve: (v: unknown) => void) => {
      if (pendingUpdate) {
        updates.push({ table, values: pendingUpdate });
        return resolve({ data: null, error: null });
      }
      return resolve({ data: matched(), error: null, count: matched().length });
    }) as unknown as (...args: unknown[]) => unknown;
    return chain;
  }
  return { rows, updates, mockFrom: (table: string) => makeChain(table) };
});

const mockTenantUser = vi.hoisted(() => ({
  current: {
    id: "admin-acme",
    tenantId: "tenant-acme",
    fullName: "Alice",
    role: { permissions: ["*"] },
  },
}));

vi.mock("@/lib/db", () => ({ getServiceClient: () => ({ from: mockFrom }) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/auth", async () => {
  const perms = await vi.importActual<typeof import("@/lib/permissions")>("@/lib/permissions");
  return {
    getApiTenantUser: () => Promise.resolve(mockTenantUser.current),
    hasPermission: perms.hasPermission,
    permissionsExceedingActor: perms.permissionsExceedingActor,
    PERMISSIONS: perms.PERMISSIONS,
  };
});

import { PATCH } from "./route";

function patch(userId: string, body: unknown) {
  return PATCH(
    new NextRequest(`http://localhost/api/users/${userId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ userId }) }
  );
}

const bobAtAcme = {
  id: "bob-acme",
  tenantId: "tenant-acme",
  authUserId: "auth-bob",
  fullName: "Bob",
  roleId: "role-eng",
  isActive: false,
};

beforeEach(() => {
  for (const k of Object.keys(rows)) delete rows[k];
  updates.length = 0;
  rows.roles = [{ id: "role-eng", tenantId: "tenant-acme", permissions: ["file.edit"] }];
});

describe("reactivating a user", () => {
  it("refuses while they are active in another workspace", async () => {
    rows.tenant_users = [
      bobAtAcme,
      { id: "bob-elsewhere", tenantId: "tenant-other", authUserId: "auth-bob", isActive: true },
    ];

    const res = await patch("bob-acme", { isActive: true });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("active in another workspace");
    expect(updates).toHaveLength(0);
  });

  it("reactivates someone whose other memberships are inactive", async () => {
    rows.tenant_users = [
      bobAtAcme,
      { id: "bob-elsewhere", tenantId: "tenant-other", authUserId: "auth-bob", isActive: false },
    ];

    const res = await patch("bob-acme", { isActive: true });

    expect(res.status).toBe(200);
    expect(updates).toEqual([{ table: "tenant_users", values: { isActive: true } }]);
  });

  it("does not count the row being reactivated as the other membership", async () => {
    // Reactivating a row that is already active is a no-op, not a conflict
    // with itself.
    rows.tenant_users = [{ ...bobAtAcme, isActive: true }];

    const res = await patch("bob-acme", { isActive: true });

    expect(res.status).toBe(200);
  });
});
