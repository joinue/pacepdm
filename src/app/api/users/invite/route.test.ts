import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createFakeSupabase, type FakeSupabase } from "@/lib/__mocks__/fake-supabase";

/**
 * Inviting someone: the privilege ceiling, where the link lands, what happens
 * to an address that already has an account, a second invitation to someone
 * who has not accepted, and one active membership per account.
 */

const state = vi.hoisted(() => ({
  fake: null as unknown as FakeSupabase,
  user: null as {
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

const anonAuth = vi.hoisted(() => ({
  resetPasswordForEmail: vi.fn(),
}));

const appEmail = vi.hoisted(() => ({
  configured: true,
  sendInviteEmail: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getServiceClient: () => state.fake.client }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { admin: authAdmin, resetPasswordForEmail: anonAuth.resetPasswordForEmail },
  }),
}));
vi.mock("@/lib/email/send", () => ({
  appEmailConfigured: () => appEmail.configured,
  sendInviteEmail: appEmail.sendInviteEmail,
}));
vi.mock("@/lib/auth", async () => {
  const perms = await vi.importActual<typeof import("@/lib/permissions")>("@/lib/permissions");
  return {
    getApiTenantUser: () => Promise.resolve(state.user),
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
  tenant: { name: "Acme Robotics", settings: {} },
};

const roleEng = { id: "role-eng", tenantId: "tenant-1", permissions: ["file.edit"] };
const roleAdmin = { id: "role-admin", tenantId: "tenant-1", permissions: ["*"] };

const alreadyRegistered = {
  data: { user: null, properties: null },
  error: {
    code: "email_exists",
    message: "A user with this email address has already been registered",
  },
};

/** generateLink answers per link type: a fresh invite, or a recovery for a confirmed account. */
function linksFor(handlers: {
  invite?: { data: unknown; error: unknown };
  recovery?: { data: unknown; error: unknown };
}) {
  authAdmin.generateLink.mockImplementation(async ({ type }: { type: string }) => {
    const answer = handlers[type as "invite" | "recovery"];
    if (!answer) throw new Error(`unexpected generateLink type ${type}`);
    return answer;
  });
}

const freshInvite = {
  data: { properties: { hashed_token: "hash-invite" }, user: { id: "auth-new" } },
  error: null,
};

const recoveryFor = (id: string) => ({
  data: { properties: { hashed_token: "hash-recovery" }, user: { id } },
  error: null,
});

const memberships = () => state.fake.rows("tenant_users");
const sentEmails = () => appEmail.sendInviteEmail.mock.calls.map((c) => c[0]);

function invite(overrides: Partial<{ email: string; fullName: string; roleId: string }> = {}) {
  return POST(
    req({ email: "pat@example.com", fullName: "Pat Lee", roleId: "role-eng", ...overrides })
  );
}

beforeEach(() => {
  state.fake = createFakeSupabase({ roles: [roleEng, roleAdmin], tenant_users: [] });
  state.user = admin;

  appEmail.configured = true;
  appEmail.sendInviteEmail.mockReset().mockResolvedValue({ ok: true, providerId: "email-1" });
  authAdmin.generateLink.mockReset();
  linksFor({ invite: freshInvite });
  authAdmin.inviteUserByEmail
    .mockReset()
    .mockResolvedValue({ data: { user: { id: "auth-new" } }, error: null });
  authAdmin.listUsers.mockReset().mockResolvedValue({ data: { users: [] }, error: null });
  anonAuth.resetPasswordForEmail.mockReset().mockResolvedValue({ data: {}, error: null });
});

/**
 * `users/[userId]` has enforced `permissionsExceedingActor` on role *changes*
 * since it was written. This route assigns a role too — it just does it to a
 * user who does not exist yet — and did not. ADMIN_USERS gates this route,
 * and Manager holds ADMIN_USERS without holding "*": a Manager could invite
 * an address they control as an Admin and return through the front door.
 */
describe("invite privilege ceiling", () => {
  it("refuses to invite someone into a more powerful role", async () => {
    state.user = manager;

    const res = await invite({ roleId: "role-admin" });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("permissions you don't hold"),
    });
    expect(memberships()).toHaveLength(0);
  });

  it("allows inviting into a role within the actor's own permissions", async () => {
    state.user = manager;
    const res = await invite({ roleId: "role-eng" });
    expect(res.status).toBe(200);
  });

  it("lets a full admin invite an admin", async () => {
    // permissionsExceedingActor short-circuits on "*", so the holder of
    // everything is never blocked by their own ceiling.
    const res = await invite({ roleId: "role-admin" });
    expect(res.status).toBe(200);
  });

  it("still refuses a caller without admin.users at all", async () => {
    state.user = { ...manager, id: "user-3", role: { permissions: ["file.edit"] } };
    const res = await invite();
    expect(res.status).toBe(403);
  });

  it("refuses a role from another workspace", async () => {
    state.fake.rows("roles").push({ id: "role-other", tenantId: "tenant-2", permissions: [] });
    const res = await invite({ roleId: "role-other" });
    expect(res.status).toBe(400);
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
 *
 * Now the app generates the token and sends the email itself, linking to
 * /auth/confirm, which verifies token_hash when the invitee clicks.
 */
describe("a new account", () => {
  it("emails a link to the app's confirm page, carrying the token hash", async () => {
    const res = await invite();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ alreadyExisted: false, resent: false });
    expect(authAdmin.generateLink).toHaveBeenCalledWith({
      type: "invite",
      email: "pat@example.com",
      options: { data: { full_name: "Pat Lee" } },
    });
    expect(authAdmin.inviteUserByEmail).not.toHaveBeenCalled();

    expect(sentEmails()).toHaveLength(1);
    const sent = sentEmails()[0];
    expect(sent).toMatchObject({
      to: "pat@example.com",
      recipientName: "Pat Lee",
      inviterName: "Alice",
      tenantName: "Acme Robotics",
      existingAccount: false,
    });
    const link = new URL(sent.link);
    expect(link.origin + link.pathname).toBe("http://localhost/auth/confirm");
    expect(Object.fromEntries(link.searchParams)).toEqual({
      token_hash: "hash-invite",
      type: "invite",
      next: "/accept-invite",
    });
  });

  it("records the membership as pending until the password is set", async () => {
    await invite();

    expect(memberships()).toHaveLength(1);
    expect(memberships()[0]).toMatchObject({
      tenantId: "tenant-1",
      authUserId: "auth-new",
      roleId: "role-eng",
      isActive: true,
      acceptedAt: null,
    });
  });

  it("adds nobody to the workspace when the email cannot be sent", async () => {
    appEmail.sendInviteEmail.mockResolvedValue({
      ok: false,
      reason: "resend 403: domain is not verified",
    });

    const res = await invite();

    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("domain is not verified");
    expect(memberships()).toHaveLength(0);
  });

  it("falls back to Supabase's mailer, pointed at /auth/confirm, when app email is not configured", async () => {
    appEmail.configured = false;

    const res = await invite();

    expect(res.status).toBe(200);
    expect(authAdmin.generateLink).not.toHaveBeenCalled();
    expect(appEmail.sendInviteEmail).not.toHaveBeenCalled();
    expect(authAdmin.inviteUserByEmail).toHaveBeenCalledWith("pat@example.com", {
      data: { full_name: "Pat Lee" },
      redirectTo: "http://localhost/auth/confirm?next=/accept-invite",
    });
    expect(memberships()[0]).toMatchObject({ authUserId: "auth-new", acceptedAt: null });
  });
});

/**
 * An address that already has a confirmed account.
 *
 * The person is added rather than invited: generateLink refuses an invite,
 * and hands back the account with a recovery token instead. That link lets
 * them set a password if they have none, and the email tells them their
 * existing password works too. They used to receive nothing at all.
 */
describe("an existing account", () => {
  beforeEach(() => {
    linksFor({ invite: alreadyRegistered, recovery: recoveryFor("auth-pat") });
  });

  it("adds them, stamped accepted, and emails a recovery link with the 'added' wording", async () => {
    const res = await invite();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ alreadyExisted: true, resent: false });
    expect(authAdmin.listUsers).not.toHaveBeenCalled();

    expect(memberships()[0]).toMatchObject({ authUserId: "auth-pat", isActive: true });
    expect(memberships()[0].acceptedAt).toEqual(expect.any(String));

    const sent = sentEmails()[0];
    expect(sent).toMatchObject({ to: "pat@example.com", existingAccount: true });
    expect(Object.fromEntries(new URL(sent.link).searchParams)).toEqual({
      token_hash: "hash-recovery",
      type: "recovery",
      next: "/accept-invite",
    });
  });

  it("without app email, finds the account in the auth user list and asks Supabase to send a recovery", async () => {
    appEmail.configured = false;
    authAdmin.inviteUserByEmail.mockResolvedValue(alreadyRegistered);
    // listUsers() without arguments returns the first page of the whole
    // project's users — 50 of them. Past that, an existing account on any
    // later page was never found and the invite failed as "already registered".
    const all = [
      ...Array.from({ length: 1500 }, (_, i) => ({ id: `auth-${i}`, email: `user${i}@other.com` })),
      { id: "auth-pat", email: "pat@example.com" },
    ];
    authAdmin.listUsers.mockImplementation(
      async ({ page = 1, perPage = 50 }: { page?: number; perPage?: number } = {}) => ({
        data: { users: all.slice((page - 1) * perPage, page * perPage) },
        error: null,
      })
    );

    const res = await invite();

    expect(res.status).toBe(200);
    expect(memberships()[0]).toMatchObject({ authUserId: "auth-pat" });
    expect(anonAuth.resetPasswordForEmail).toHaveBeenCalledWith("pat@example.com", {
      redirectTo: "http://localhost/auth/confirm?next=/accept-invite",
    });
  });

  it("without app email, reports the error when the auth user list has no match", async () => {
    appEmail.configured = false;
    authAdmin.inviteUserByEmail.mockResolvedValue(alreadyRegistered);
    authAdmin.listUsers.mockImplementation(async ({ page = 1 }: { page?: number } = {}) => ({
      data: { users: page === 1 ? [{ id: "auth-other", email: "someone@else.com" }] : [] },
      error: null,
    }));

    const res = await invite();

    expect(res.status).toBe(400);
    expect(memberships()).toHaveLength(0);
    expect(anonAuth.resetPasswordForEmail).not.toHaveBeenCalled();
  });
});

/**
 * Inviting someone who has been invited and has not accepted.
 *
 * The link expires — Supabase's email OTP expiry, an hour by default — and
 * the invitation email tells them to ask for a new one. A second invitation
 * used to be refused as "already exists in this workspace", so the only way
 * to reissue was Remove → Invite.
 */
describe("a pending invitation", () => {
  const pending = {
    id: "tu-pat",
    tenantId: "tenant-1",
    authUserId: "auth-new",
    email: "pat@example.com",
    fullName: "Pat",
    roleId: "role-eng",
    isActive: true,
    acceptedAt: null,
  };

  it("is sent again, with the name and role restated, instead of being refused", async () => {
    state.fake.rows("tenant_users").push({ ...pending });

    const res = await invite({ fullName: "Pat Lee", roleId: "role-admin" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resent: true, alreadyExisted: false });
    expect(sentEmails()).toHaveLength(1);
    expect(sentEmails()[0]).toMatchObject({ to: "pat@example.com", existingAccount: false });

    expect(memberships()).toHaveLength(1);
    expect(memberships()[0]).toMatchObject({
      id: "tu-pat",
      fullName: "Pat Lee",
      roleId: "role-admin",
      acceptedAt: null,
    });
  });

  it("still applies the privilege ceiling to the restated role", async () => {
    state.user = manager;
    state.fake.rows("tenant_users").push({ ...pending });

    const res = await invite({ roleId: "role-admin" });

    expect(res.status).toBe(403);
    expect(sentEmails()).toHaveLength(0);
  });

  it("uses a recovery link, with invitation wording, when the invitee confirmed but never set a password", async () => {
    // They clicked Continue on the first email, which confirmed the account
    // and signed them in, then closed the tab. generateLink will not invite a
    // confirmed account, but they are still being invited.
    state.fake.rows("tenant_users").push({ ...pending });
    linksFor({ invite: alreadyRegistered, recovery: recoveryFor("auth-new") });

    const res = await invite();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resent: true, alreadyExisted: false });
    const sent = sentEmails()[0];
    expect(sent.existingAccount).toBe(false);
    expect(new URL(sent.link).searchParams.get("type")).toBe("recovery");
    expect(memberships()[0].acceptedAt).toBeNull();
  });

  it("refuses to re-invite someone who has already accepted", async () => {
    state.fake.rows("tenant_users").push({ ...pending, acceptedAt: "2026-09-01T00:00:00Z" });

    const res = await invite();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("already exists in this workspace");
    expect(sentEmails()).toHaveLength(0);
  });

  it("asks for a reactivation rather than resending to a deactivated invitee", async () => {
    state.fake.rows("tenant_users").push({ ...pending, isActive: false });

    const res = await invite();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("Reactivate");
    expect(sentEmails()).toHaveLength(0);
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
  // Mallory runs her own workspace — sign-up is open, so she is its Admin.
  const mallory = {
    id: "mal-1",
    tenantId: "tenant-mal",
    fullName: "Mallory",
    role: { permissions: ["*"] },
    tenant: { name: "Mallory Inc" },
  };
  const roleMal = { id: "role-mal", tenantId: "tenant-mal", permissions: ["file.edit"] };

  const bobAtAcme = {
    id: "bob-acme",
    tenantId: "tenant-acme",
    authUserId: "auth-bob",
    email: "bob@acme.com",
    isActive: true,
    acceptedAt: "2026-01-01T00:00:00Z",
  };

  beforeEach(() => {
    state.user = mallory;
    state.fake.rows("roles").push(roleMal);
    linksFor({ invite: alreadyRegistered, recovery: recoveryFor("auth-bob") });
  });

  const inviteBob = (email = "bob@acme.com") => invite({ email, fullName: "Bob", roleId: "role-mal" });

  it("refuses to invite a differently capitalised address that is active in another workspace", async () => {
    state.fake.rows("tenant_users").push({ ...bobAtAcme });

    const res = await inviteBob("Bob@Acme.com");

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("active in another workspace");
    expect(memberships()).toHaveLength(1);
    expect(authAdmin.generateLink).not.toHaveBeenCalled();
  });

  it("checks the account, not the email, once the account is found — and sends nothing", async () => {
    // The membership row was created under a different address than the one
    // the account now has, so no email lookup can connect them.
    state.fake.rows("tenant_users").push({ ...bobAtAcme, email: "robert.smith@acme.com" });

    const res = await inviteBob();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("active in another workspace");
    expect(memberships()).toHaveLength(1);
    expect(sentEmails()).toHaveLength(0);
  });

  it("adds an existing account that is not active anywhere", async () => {
    state.fake.rows("tenant_users").push({ ...bobAtAcme, isActive: false });

    const res = await inviteBob();

    expect(res.status).toBe(200);
    const added = memberships().find((m) => m.tenantId === "tenant-mal");
    expect(added).toMatchObject({ authUserId: "auth-bob", isActive: true });
    expect(sentEmails()).toHaveLength(1);
  });

  it("finds a member of this workspace whatever the capitalisation", async () => {
    state.fake.rows("tenant_users").push({
      ...bobAtAcme,
      id: "pat-mal",
      tenantId: "tenant-mal",
      authUserId: "auth-pat",
      email: "Pat@Example.com",
    });

    const res = await invite({ email: "pat@example.com", roleId: "role-mal" });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("already exists in this workspace");
  });

  it("does not treat an underscore in the address as a wildcard", async () => {
    state.fake.rows("tenant_users").push({ ...bobAtAcme, email: "bobxsmith@acme.com" });
    linksFor({ invite: freshInvite });

    const res = await inviteBob("bob_smith@acme.com");

    expect(res.status).toBe(200);
  });

  it("stores the address lowercased", async () => {
    linksFor({ invite: freshInvite });

    await invite({ email: "  Pat.Lee@Example.COM ", roleId: "role-mal" });

    expect(memberships()[0]).toMatchObject({ email: "pat.lee@example.com" });
  });

  it("answers 409, not 500, when the database refuses a second active membership", async () => {
    // Migration 054's partial unique index — the backstop for a race past
    // the checks above.
    linksFor({ invite: freshInvite });
    state.fake.failNext.insert.tenant_users = {
      code: "23505",
      message:
        'duplicate key value violates unique constraint "tenant_users_one_active_per_auth_user"',
    };

    const res = await invite({ roleId: "role-mal" });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("active in another workspace");
  });
});
