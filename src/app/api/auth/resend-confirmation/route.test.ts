import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * A new confirmation link from the sign-in page, for an account whose
 * original link expired or was consumed. Issued as a recovery token — the
 * route has no password to issue a signup token with — which confirms the
 * account when verified and lands on onboarding.
 */

const authAdmin = vi.hoisted(() => ({ generateLink: vi.fn() }));
const serverAuth = vi.hoisted(() => ({ resend: vi.fn() }));
const appEmail = vi.hoisted(() => ({
  configured: true,
  sendSignupConfirmationEmail: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getServiceClient: () => ({}) }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { admin: authAdmin } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => ({ auth: serverAuth }),
}));
vi.mock("@/lib/email/send", () => ({
  appEmailConfigured: () => appEmail.configured,
  sendSignupConfirmationEmail: appEmail.sendSignupConfirmationEmail,
}));

import { POST } from "./route";

const resend = (email = "ada@example.com") =>
  POST(
    new NextRequest("http://localhost/api/auth/resend-confirmation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    })
  );

beforeEach(() => {
  appEmail.configured = true;
  appEmail.sendSignupConfirmationEmail.mockReset().mockResolvedValue({ ok: true });
  authAdmin.generateLink.mockReset().mockResolvedValue({
    data: {
      properties: { hashed_token: "hash-rec" },
      user: { id: "auth-ada", email_confirmed_at: null, user_metadata: { full_name: "Ada L" } },
    },
    error: null,
  });
  serverAuth.resend.mockReset().mockResolvedValue({ data: {}, error: null });
});

describe("POST /api/auth/resend-confirmation", () => {
  it("emails a recovery link that lands on onboarding", async () => {
    const res = await resend();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "sent" });
    expect(authAdmin.generateLink).toHaveBeenCalledWith({
      type: "recovery",
      email: "ada@example.com",
    });
    const sent = appEmail.sendSignupConfirmationEmail.mock.calls[0][0];
    expect(sent.recipientName).toBe("Ada L");
    expect(Object.fromEntries(new URL(sent.link).searchParams)).toEqual({
      token_hash: "hash-rec",
      type: "recovery",
      next: "/onboarding",
    });
  });

  it("sends nothing to an account that is already confirmed", async () => {
    authAdmin.generateLink.mockResolvedValue({
      data: {
        properties: { hashed_token: "hash-rec" },
        user: { id: "auth-ada", email_confirmed_at: "2026-09-01T00:00:00Z" },
      },
      error: null,
    });

    expect(await (await resend()).json()).toEqual({ status: "already-confirmed" });
    expect(appEmail.sendSignupConfirmationEmail).not.toHaveBeenCalled();
  });

  it("says when no account uses the address", async () => {
    authAdmin.generateLink.mockResolvedValue({
      data: { user: null, properties: null },
      error: { status: 404, code: "user_not_found", message: "User not found" },
    });

    const res = await resend();

    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("Create a workspace");
  });

  it("falls back to Supabase's own resend without app email", async () => {
    appEmail.configured = false;

    expect(await (await resend()).json()).toEqual({ status: "sent" });
    expect(serverAuth.resend).toHaveBeenCalledWith({
      type: "signup",
      email: "ada@example.com",
      options: { emailRedirectTo: "http://localhost/auth/callback?next=/onboarding" },
    });
    expect(authAdmin.generateLink).not.toHaveBeenCalled();
  });
});
