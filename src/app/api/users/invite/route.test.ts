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

const { tableResults, tableRows, insertErrors, inserts, mockFrom } = vi.hoisted(() => {
  type QueryResult = { data: unknown; error: unknown };
  type Row = Record<string, unknown>;
  const tableResults: Record<string, QueryResult> = {};
  const insertErrors: Record<string, { code: string; message: string }> = {};
  const inserts: { table: string; row: Record<string, unknown> }[] = [];

  /**
   * Rows for tables whose queries must actually be filtered. A canned result
   * answers every query on a table the same way, which cannot tell "this
   * email in my workspace" from "this account active anywhere" — and a mock
   * that cannot tell those apart is how the case-sensitive lookup survived.
   */
  const tableRows: Record<string, Row[]> = {};

  /** Postgres ILIKE: `%` any run, `_` one character, backslash escapes. */
  function ilikeMatches(value: unknown, pattern: string) {
    let re = "";
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === "\\" && i + 1 < pattern.length)
        re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      else if (c === "%") re += ".*";
      else if (c === "_") re += ".";
      else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return typeof value === "string" && new RegExp(`^${re}$`, "i").test(value);
  }

  function makeChain(table: string) {
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    const filters: ((row: Row) => boolean)[] = [];
    let limit: number | undefined;
    const matched = () => {
      const rows = tableRows[table]!.filter((r) => filters.every((f) => f(r)));
      return limit === undefined ? rows : rows.slice(0, limit);
    };
    const resolvable = () => tableResults[table] ?? { data: null, error: null };
    const one = () => {
      if (!tableRows[table]) return resolvable();
      const rows = matched();
      return { data: rows[0] ?? null, error: null };
    };
    const many = () => (tableRows[table] ? { data: matched(), error: null } : resolvable());

    for (const m of ["select", "in", "is", "order"] as const) {
      chain[m] = () => chain;
    }
    chain.eq = (col: unknown, val: unknown) => {
      filters.push((r) => r[col as string] === val);
      return chain;
    };
    chain.neq = (col: unknown, val: unknown) => {
      filters.push((r) => r[col as string] !== val);
      return chain;
    };
    chain.ilike = (col: unknown, pattern: unknown) => {
      filters.push((r) => ilikeMatches(r[col as string], pattern as string));
      return chain;
    };
    chain.limit = (n: unknown) => {
      limit = n as number;
      return chain;
    };
    chain.single = () => one();
    chain.maybeSingle = () => one();
    chain.insert = (row: unknown) => {
      const error = insertErrors[table] ?? null;
      if (!error) inserts.push({ table, row: row as Record<string, unknown> });
      return {
        select: () => ({
          single: () => Promise.resolve(error ? { data: null, error } : { data: row, error: null }),
        }),
      };
    };
    chain.update = () => {
      const u: Record<string, (...a: unknown[]) => unknown> = {};
      for (const m of ["eq", "select"] as const) u[m] = () => u;
      u.single = () => resolvable();
      return u;
    };
    chain.then = ((resolve: (v: unknown) => void) => resolve(many())) as unknown as (
      ...args: unknown[]
    ) => unknown;
    return chain;
  }
  return {
    tableResults,
    tableRows,
    insertErrors,
    inserts,
    mockFrom: (table: string) => makeChain(table),
  };
});

const mockTenantUser = vi.hoisted(() => ({
  current: null as {
    id: string;
    tenantId: string;
    fullName: string;
    role: { permissions: string[] };
    tenant?: { name: string; settings?: Record<string, unknown> };
  } | null,
}));

const authAdmin = vi.hoisted(() => ({
  generateLink: vi.fn(),
  inviteUserByEmail: vi.fn(),
  listUsers: vi.fn(),
}));

const appEmail = vi.hoisted(() => ({
  configured: true,
  sendInviteEmail: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getServiceClient: () => ({ from: mockFrom }) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { admin: authAdmin } }),
}));
vi.mock("@/lib/email/send", () => ({
  appEmailConfigured: () => appEmail.configured,
  sendInviteEmail: appEmail.sendInviteEmail,
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
  for (const k of Object.keys(tableRows)) delete tableRows[k];
  for (const k of Object.keys(insertErrors)) delete insertErrors[k];
  inserts.length = 0;
  mockTenantUser.current = null;

  appEmail.configured = true;
  appEmail.sendInviteEmail.mockReset().mockResolvedValue({ ok: true, providerId: "email-1" });
  authAdmin.generateLink.mockReset().mockResolvedValue({
    data: { properties: { hashed_token: "hash-abc" }, user: { id: "auth-new" } },
    error: null,
  });
  authAdmin.inviteUserByEmail
    .mockReset()
    .mockResolvedValue({ data: { user: { id: "auth-new" } }, error: null });
  authAdmin.listUsers.mockReset().mockResolvedValue({ data: { users: [] }, error: null });
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

/**
 * Where the invitation link lands.
 *
 * The route used to call inviteUserByEmail with redirectTo /auth/callback.
 * Supabase's default invite template links to its own /verify endpoint, which
 * signs the invitee in with tokens in the URL #fragment — invites cannot use
 * PKCE. /auth/callback is a server route that only understands ?code=, never
 * sees a fragment, and redirected every invitee to /login?error=missing_code.
 * It worked only if someone had customised the dashboard template.
 *
 * Now the app generates the token and sends the email itself, linking to
 * /auth/confirm, which verifies token_hash when the invitee clicks.
 */
describe("invite link", () => {
  const acme = { ...admin, tenant: { name: "Acme Robotics", settings: {} } };

  function inviteReady() {
    mockTenantUser.current = acme;
    tableResults.tenant_users = { data: null, error: null };
    tableResults.roles = { data: { id: "role-eng", permissions: ["file.edit"] }, error: null };
  }

  const tenantUserInserts = () => inserts.filter((i) => i.table === "tenant_users");

  it("emails a link to the app's confirm page, carrying the token hash", async () => {
    inviteReady();

    const res = await POST(
      req({ email: "pat@example.com", fullName: "Pat Lee", roleId: "role-eng" })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ alreadyExisted: false });
    expect(authAdmin.generateLink).toHaveBeenCalledWith({
      type: "invite",
      email: "pat@example.com",
      options: { data: { full_name: "Pat Lee" } },
    });
    expect(authAdmin.inviteUserByEmail).not.toHaveBeenCalled();

    expect(appEmail.sendInviteEmail).toHaveBeenCalledTimes(1);
    const sent = appEmail.sendInviteEmail.mock.calls[0][0];
    expect(sent).toMatchObject({
      to: "pat@example.com",
      recipientName: "Pat Lee",
      inviterName: "Alice",
      tenantName: "Acme Robotics",
    });
    const link = new URL(sent.link);
    expect(link.origin + link.pathname).toBe("http://localhost/auth/confirm");
    expect(Object.fromEntries(link.searchParams)).toEqual({
      token_hash: "hash-abc",
      type: "invite",
      next: "/accept-invite",
    });

    expect(tenantUserInserts()).toHaveLength(1);
    expect(tenantUserInserts()[0].row).toMatchObject({
      authUserId: "auth-new",
      roleId: "role-eng",
    });
  });

  it("adds nobody to the workspace when the email cannot be sent", async () => {
    inviteReady();
    appEmail.sendInviteEmail.mockResolvedValue({
      ok: false,
      reason: "resend 403: domain is not verified",
    });

    const res = await POST(
      req({ email: "pat@example.com", fullName: "Pat Lee", roleId: "role-eng" })
    );

    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("domain is not verified");
    expect(tenantUserInserts()).toHaveLength(0);
  });

  it("falls back to Supabase's mailer, pointed at /auth/confirm, when app email is not configured", async () => {
    inviteReady();
    appEmail.configured = false;

    const res = await POST(
      req({ email: "pat@example.com", fullName: "Pat Lee", roleId: "role-eng" })
    );

    expect(res.status).toBe(200);
    expect(authAdmin.generateLink).not.toHaveBeenCalled();
    expect(appEmail.sendInviteEmail).not.toHaveBeenCalled();
    expect(authAdmin.inviteUserByEmail).toHaveBeenCalledWith("pat@example.com", {
      data: { full_name: "Pat Lee" },
      redirectTo: "http://localhost/auth/confirm?next=/accept-invite",
    });
  });
});

/**
 * Adding someone who already has an account.
 *
 * listUsers() without arguments returns the first page of the whole Supabase
 * project's users — 50 of them. Past that, an existing account on any later
 * page was never found and the invite failed with "already registered".
 */
describe("inviting an existing account", () => {
  const alreadyRegistered = {
    data: { user: null, properties: null },
    error: {
      code: "email_exists",
      message: "A user with this email address has already been registered",
    },
  };

  function existingAccount() {
    mockTenantUser.current = admin;
    tableResults.tenant_users = { data: null, error: null };
    tableResults.roles = { data: { id: "role-eng", permissions: ["file.edit"] }, error: null };
    authAdmin.generateLink.mockResolvedValue(alreadyRegistered);
    authAdmin.inviteUserByEmail.mockResolvedValue(alreadyRegistered);
  }

  /** A project whose users span several pages of `perPage`. */
  function authUsers(all: { id: string; email: string }[]) {
    authAdmin.listUsers.mockImplementation(
      async ({ page = 1, perPage = 50 }: { page?: number; perPage?: number } = {}) => ({
        data: { users: all.slice((page - 1) * perPage, page * perPage) },
        error: null,
      })
    );
  }

  const tenantUserInserts = () => inserts.filter((i) => i.table === "tenant_users");

  it("finds the account when it is not on the first page of auth users", async () => {
    existingAccount();
    authUsers([
      ...Array.from({ length: 1500 }, (_, i) => ({ id: `auth-${i}`, email: `user${i}@other.com` })),
      { id: "auth-pat", email: "pat@example.com" },
    ]);

    const res = await POST(
      req({ email: "pat@example.com", fullName: "Pat Lee", roleId: "role-eng" })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ alreadyExisted: true });
    expect(tenantUserInserts()[0].row).toMatchObject({ authUserId: "auth-pat" });
    expect(appEmail.sendInviteEmail).not.toHaveBeenCalled();
  });

  it("matches the account's email regardless of how the admin capitalised it", async () => {
    existingAccount();
    authUsers([{ id: "auth-pat", email: "pat@example.com" }]);

    const res = await POST(
      req({ email: "Pat@Example.com", fullName: "Pat Lee", roleId: "role-eng" })
    );

    expect(res.status).toBe(200);
    expect(tenantUserInserts()[0].row).toMatchObject({ authUserId: "auth-pat" });
  });

  it("stops at the last page and reports the error when there is no match", async () => {
    existingAccount();
    authUsers([{ id: "auth-other", email: "someone@else.com" }]);

    const res = await POST(
      req({ email: "pat@example.com", fullName: "Pat Lee", roleId: "role-eng" })
    );

    expect(res.status).toBe(400);
    expect(tenantUserInserts()).toHaveLength(0);
    expect(authAdmin.listUsers).toHaveBeenCalledTimes(2);
  });
});

/**
 * One active membership per account.
 *
 * Sign-in resolves the caller with `.single()` over their active memberships,
 * so a second active row locks them out of their own workspace. The only guard
 * compared emails case-sensitively while the account lookup lowercased: any
 * stranger could create a workspace, invite `Bob@Acme.com`, and lock Bob out.
 */
describe("one active membership per account", () => {
  const alreadyRegistered = {
    data: { user: null, properties: null },
    error: {
      code: "email_exists",
      message: "A user with this email address has already been registered",
    },
  };

  // Mallory runs her own workspace — sign-up is open, so she is its Admin.
  const mallory = {
    id: "mal-1",
    tenantId: "tenant-mal",
    fullName: "Mallory",
    role: { permissions: ["*"] },
  };

  const bobAtAcme = {
    id: "bob-acme",
    tenantId: "tenant-acme",
    authUserId: "auth-bob",
    email: "bob@acme.com",
    isActive: true,
  };

  function strangerInvites() {
    mockTenantUser.current = mallory;
    tableRows.tenant_users = [bobAtAcme];
    tableResults.roles = { data: { id: "role-eng", permissions: ["file.edit"] }, error: null };
    authAdmin.generateLink.mockResolvedValue(alreadyRegistered);
    authAdmin.listUsers.mockResolvedValue({
      data: { users: [{ id: "auth-bob", email: "bob@acme.com" }] },
      error: null,
    });
  }

  const tenantUserInserts = () => inserts.filter((i) => i.table === "tenant_users");

  it("refuses to invite a differently capitalised address that is active in another workspace", async () => {
    strangerInvites();

    const res = await POST(req({ email: "Bob@Acme.com", fullName: "Bob", roleId: "role-eng" }));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("active in another workspace");
    expect(tenantUserInserts()).toHaveLength(0);
    expect(authAdmin.generateLink).not.toHaveBeenCalled();
  });

  it("checks the account, not the email, once the account is found", async () => {
    // The membership row was created under a different address than the one
    // the account now has, so no email lookup can connect them.
    strangerInvites();
    tableRows.tenant_users = [{ ...bobAtAcme, email: "robert.smith@acme.com" }];

    const res = await POST(req({ email: "bob@acme.com", fullName: "Bob", roleId: "role-eng" }));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("active in another workspace");
    expect(tenantUserInserts()).toHaveLength(0);
  });

  it("adds an existing account that is not active anywhere", async () => {
    strangerInvites();
    tableRows.tenant_users = [{ ...bobAtAcme, isActive: false }];

    const res = await POST(req({ email: "bob@acme.com", fullName: "Bob", roleId: "role-eng" }));

    expect(res.status).toBe(200);
    expect(tenantUserInserts()[0].row).toMatchObject({ authUserId: "auth-bob", isActive: true });
  });

  it("finds a member of this workspace whatever the capitalisation", async () => {
    mockTenantUser.current = mallory;
    tableRows.tenant_users = [
      {
        id: "pat-mal",
        tenantId: "tenant-mal",
        authUserId: "auth-pat",
        email: "Pat@Example.com",
        isActive: true,
      },
    ];
    tableResults.roles = { data: { id: "role-eng", permissions: ["file.edit"] }, error: null };

    const res = await POST(req({ email: "pat@example.com", fullName: "Pat", roleId: "role-eng" }));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("already exists in this workspace");
  });

  it("does not treat an underscore in the address as a wildcard", async () => {
    mockTenantUser.current = mallory;
    tableRows.tenant_users = [{ ...bobAtAcme, email: "bobxsmith@acme.com" }];
    tableResults.roles = { data: { id: "role-eng", permissions: ["file.edit"] }, error: null };

    const res = await POST(
      req({ email: "bob_smith@acme.com", fullName: "Bob", roleId: "role-eng" })
    );

    expect(res.status).toBe(200);
  });

  it("stores the address lowercased", async () => {
    mockTenantUser.current = mallory;
    tableRows.tenant_users = [];
    tableResults.roles = { data: { id: "role-eng", permissions: ["file.edit"] }, error: null };

    await POST(req({ email: "  Pat.Lee@Example.COM ", fullName: "Pat", roleId: "role-eng" }));

    expect(tenantUserInserts()[0].row).toMatchObject({ email: "pat.lee@example.com" });
  });

  it("answers 409, not 500, when the database refuses a second active membership", async () => {
    // Migration 054's partial unique index — the backstop for a race past
    // the checks above.
    mockTenantUser.current = mallory;
    tableRows.tenant_users = [];
    tableResults.roles = { data: { id: "role-eng", permissions: ["file.edit"] }, error: null };
    insertErrors.tenant_users = {
      code: "23505",
      message:
        'duplicate key value violates unique constraint "tenant_users_one_active_per_auth_user"',
    };

    const res = await POST(req({ email: "pat@example.com", fullName: "Pat", roleId: "role-eng" }));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("active in another workspace");
  });
});
