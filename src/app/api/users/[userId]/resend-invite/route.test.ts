import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createFakeSupabase, type FakeSupabase } from "@/lib/__mocks__/fake-supabase";

/**
 * Resending an invitation from the Users page.
 *
 * Only a pending membership can be resent: once the person has a password
 * they sign in like anyone else. The link type follows the account's state
 * (see lib/invitations.ts), but the email is always the invitation.
 */

const state = vi.hoisted(() => ({
  fake: null as unknown as FakeSupabase,
  user: {
    id: "user-1",
    tenantId: "tenant-1",
    fullName: "Alice",
    role: { permissions: ["admin.users"] },
    tenant: { name: "Acme Robotics", settings: { emailReplyTo: "eng@acme.test" } },
  },
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

const audit = vi.hoisted(() => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@/lib/db", () => ({ getServiceClient: () => state.fake.client }));
vi.mock("@/lib/audit", () => audit);
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { admin: authAdmin } }),
}));
vi.mock("@/lib/email/send", () => ({
  appEmailConfigured: () => appEmail.configured,
  sendInviteEmail: appEmail.sendInviteEmail,
}));
vi.mock("@/lib/auth", async () => {
  const perms = await vi.importActual<typeof import("@/lib/permissions")>("@/lib/permissions");
  return { getApiTenantUser: () => Promise.resolve(state.user), PERMISSIONS: perms.PERMISSIONS };
});

import { POST } from "./route";

const PAT = "6f1d6b4e-2f0c-4b7e-9d0a-2b0f9f8b1c01";

const resend = (userId = PAT) =>
  POST(
    new NextRequest(`http://localhost/api/users/${userId}/resend-invite`, { method: "POST" }),
    { params: Promise.resolve({ userId }) }
  );

const pending = {
  id: PAT,
  tenantId: "tenant-1",
  authUserId: "auth-pat",
  email: "pat@example.com",
  fullName: "Pat Lee",
  roleId: "role-eng",
  isActive: true,
  acceptedAt: null,
};

beforeEach(() => {
  state.fake = createFakeSupabase({ tenant_users: [{ ...pending }] });
  appEmail.configured = true;
  appEmail.sendInviteEmail.mockReset().mockResolvedValue({ ok: true });
  audit.logAudit.mockClear();
  authAdmin.generateLink.mockReset().mockResolvedValue({
    data: { properties: { hashed_token: "hash-2" }, user: { id: "auth-pat" } },
    error: null,
  });
});

describe("POST /api/users/[userId]/resend-invite", () => {
  it("reissues the invite link and emails it with the workspace's reply-to", async () => {
    const res = await resend();

    expect(res.status).toBe(200);
    expect(authAdmin.generateLink).toHaveBeenCalledWith({
      type: "invite",
      email: "pat@example.com",
      options: { data: { full_name: "Pat Lee" } },
    });
    expect(appEmail.sendInviteEmail).toHaveBeenCalledTimes(1);
    const sent = appEmail.sendInviteEmail.mock.calls[0][0];
    expect(sent).toMatchObject({
      to: "pat@example.com",
      recipientName: "Pat Lee",
      inviterName: "Alice",
      tenantName: "Acme Robotics",
      existingAccount: false,
      replyTo: "eng@acme.test",
    });
    expect(new URL(sent.link).searchParams.get("token_hash")).toBe("hash-2");
    expect(audit.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "user.invite_resend", entityId: PAT })
    );
  });

  it("uses a recovery link when the invitee confirmed the account but never set a password", async () => {
    authAdmin.generateLink.mockImplementation(async ({ type }: { type: string }) =>
      type === "invite"
        ? { data: { user: null, properties: null }, error: { code: "email_exists", message: "registered" } }
        : { data: { properties: { hashed_token: "hash-rec" }, user: { id: "auth-pat" } }, error: null }
    );

    const res = await resend();

    expect(res.status).toBe(200);
    const sent = appEmail.sendInviteEmail.mock.calls[0][0];
    expect(new URL(sent.link).searchParams.get("type")).toBe("recovery");
    // Still an invitation: they have no password to sign in with.
    expect(sent.existingAccount).toBe(false);
    expect(state.fake.rows("tenant_users")[0].acceptedAt).toBeNull();
  });

  it("refuses once the invitation has been accepted", async () => {
    state.fake.rows("tenant_users")[0].acceptedAt = "2026-09-01T00:00:00Z";

    const res = await resend();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("already accepted");
    expect(appEmail.sendInviteEmail).not.toHaveBeenCalled();
  });

  it("refuses for a deactivated invitee", async () => {
    state.fake.rows("tenant_users")[0].isActive = false;

    const res = await resend();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("Reactivate");
  });

  it("cannot reach a member of another workspace", async () => {
    state.fake.rows("tenant_users")[0].tenantId = "tenant-2";

    const res = await resend();

    expect(res.status).toBe(404);
    expect(authAdmin.generateLink).not.toHaveBeenCalled();
  });

  it("reports a failed send and leaves the row alone", async () => {
    appEmail.sendInviteEmail.mockResolvedValue({ ok: false, reason: "resend 500: down" });

    const res = await resend();

    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("down");
    expect(audit.logAudit).not.toHaveBeenCalled();
  });

  it("requires admin.users", async () => {
    state.user = { ...state.user, role: { permissions: ["file.edit"] } };

    const res = await resend();

    expect(res.status).toBe(403);
  });
});
