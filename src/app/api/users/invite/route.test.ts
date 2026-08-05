import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The privilege ceiling on invitation.
 *
 * `users/[userId]` has enforced `permissionsExceedingActor` on role *changes*
 * since it was written. This route assigns a role too — it just does it to a
 * user who does not exist yet — and did not.
 *
 * That gap was reachable on the seeded roles rather than only in theory:
 * ADMIN_USERS gates this route, and Manager holds ADMIN_USERS without holding
 * "*". A Manager could invite an address they control as an Admin and return
 * through the front door with permissions nobody granted them.
 */

const { tableResults, mockFrom } = vi.hoisted(() => {
  type QueryResult = { data: unknown; error: unknown };
  const tableResults: Record<string, QueryResult> = {};

  function makeChain(table: string) {
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    const resolvable = () => tableResults[table] ?? { data: null, error: null };
    for (const m of ["select", "eq", "in", "neq", "is", "order", "limit", "ilike"] as const) {
      chain[m] = () => chain;
    }
    chain.single = () => resolvable();
    chain.maybeSingle = () => resolvable();
    chain.insert = () => Promise.resolve({ data: null, error: null });
    chain.update = () => {
      const u: Record<string, (...a: unknown[]) => unknown> = {};
      for (const m of ["eq", "select"] as const) u[m] = () => u;
      u.single = () => resolvable();
      return u;
    };
    chain.then = ((resolve: (v: unknown) => void) => resolve(resolvable())) as unknown as (
      ...args: unknown[]
    ) => unknown;
    return chain;
  }
  return { tableResults, mockFrom: (table: string) => makeChain(table) };
});

const mockTenantUser = vi.hoisted(() => ({
  current: null as {
    id: string;
    tenantId: string;
    fullName: string;
    role: { permissions: string[] };
  } | null,
}));

vi.mock("@/lib/db", () => ({ getServiceClient: () => ({ from: mockFrom }) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      admin: {
        inviteUserByEmail: vi
          .fn()
          .mockResolvedValue({ data: { user: { id: "auth-1" } }, error: null }),
      },
    },
  }),
}));
vi.mock("@/lib/auth", async () => {
  const perms = await vi.importActual<typeof import("@/lib/permissions")>("@/lib/permissions");
  return {
    getApiTenantUser: () => Promise.resolve(mockTenantUser.current),
    hasPermission: perms.hasPermission,
    permissionsExceedingActor: perms.permissionsExceedingActor,
    PERMISSIONS: perms.PERMISSIONS,
  };
});

import { POST } from "./route";

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/users/invite", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

// Holds admin.users but not "*" — the seeded Manager shape.
const manager = {
  id: "user-2",
  tenantId: "tenant-1",
  fullName: "Bob",
  role: { permissions: ["admin.users", "file.edit", "eco.approve"] },
};

const admin = {
  id: "user-1",
  tenantId: "tenant-1",
  fullName: "Alice",
  role: { permissions: ["*"] },
};

beforeEach(() => {
  for (const k of Object.keys(tableResults)) delete tableResults[k];
  mockTenantUser.current = null;
});

describe("invite privilege ceiling", () => {
  it("refuses to invite someone into a more powerful role", async () => {
    mockTenantUser.current = manager;
    tableResults.tenant_users = { data: null, error: null }; // no existing user
    tableResults.roles = { data: { id: "role-admin", permissions: ["*"] }, error: null };

    const res = await POST(req({ email: "x@y.com", fullName: "X", roleId: "role-admin" }));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("permissions you don't hold"),
    });
  });

  it("allows inviting into a role within the actor's own permissions", async () => {
    mockTenantUser.current = manager;
    tableResults.tenant_users = { data: null, error: null };
    tableResults.roles = { data: { id: "role-eng", permissions: ["file.edit"] }, error: null };

    const res = await POST(req({ email: "x@y.com", fullName: "X", roleId: "role-eng" }));

    expect(res.status).not.toBe(403);
  });

  it("lets a full admin invite an admin", async () => {
    // permissionsExceedingActor short-circuits on "*", so the holder of
    // everything is never blocked by their own ceiling.
    mockTenantUser.current = admin;
    tableResults.tenant_users = { data: null, error: null };
    tableResults.roles = { data: { id: "role-admin", permissions: ["*"] }, error: null };

    const res = await POST(req({ email: "x@y.com", fullName: "X", roleId: "role-admin" }));

    expect(res.status).not.toBe(403);
  });

  it("still refuses a caller without admin.users at all", async () => {
    mockTenantUser.current = {
      id: "user-3",
      tenantId: "tenant-1",
      fullName: "Carol",
      role: { permissions: ["file.edit"] },
    };

    const res = await POST(req({ email: "x@y.com", fullName: "X", roleId: "role-eng" }));

    expect(res.status).toBe(403);
  });
});
