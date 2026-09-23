import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Sign-up through the server.
 *
 * The page used to call supabase.auth.signUp in the browser: the link only
 * worked in that browser (PKCE), went through Supabase's own /verify (which
 * link scanners consumed), and an existing address got a "check your email"
 * screen that no email followed.
 */

const authAdmin = vi.hoisted(() => ({ generateLink: vi.fn() }));
const serverAuth = vi.hoisted(() => ({ signUp: vi.fn() }));
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

const body = {
  email: "Ada@Example.com",
  password: "hunter22",
  fullName: "Ada Lovelace",
  companyName: "Analytical Engines",
};

const register = (overrides: Partial<typeof body> = {}) =>
  POST(
    new NextRequest("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, ...overrides }),
    })
  );

beforeEach(() => {
  appEmail.configured = true;
  appEmail.sendSignupConfirmationEmail.mockReset().mockResolvedValue({ ok: true });
  authAdmin.generateLink.mockReset().mockResolvedValue({
    data: {
      properties: { hashed_token: "hash-signup" },
      user: { id: "auth-ada", email_confirmed_at: null },
    },
    error: null,
  });
  serverAuth.signUp.mockReset();
});

describe("POST /api/auth/register", () => {
  it("issues a signup token and emails a link to the app's confirm page", async () => {
    const res = await register();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "sent" });
    expect(authAdmin.generateLink).toHaveBeenCalledWith({
      type: "signup",
      email: "ada@example.com",
      password: "hunter22",
      options: { data: { full_name: "Ada Lovelace", company_name: "Analytical Engines" } },
    });

    const sent = appEmail.sendSignupConfirmationEmail.mock.calls[0][0];
    expect(sent).toMatchObject({ to: "ada@example.com", recipientName: "Ada Lovelace" });
    const link = new URL(sent.link);
    expect(link.origin + link.pathname).toBe("http://localhost/auth/confirm");
    expect(Object.fromEntries(link.searchParams)).toEqual({
      token_hash: "hash-signup",
      type: "signup",
      next: "/onboarding",
    });
  });

  it("says so when the address already has a confirmed account", async () => {
    authAdmin.generateLink.mockResolvedValue({
      data: { user: null, properties: null },
      error: { code: "email_exists", message: "A user with this email address has already been registered" },
    });

    const res = await register();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "exists" });
    expect(appEmail.sendSignupConfirmationEmail).not.toHaveBeenCalled();
  });

  it("skips the email when confirmations are off and the account is already usable", async () => {
    authAdmin.generateLink.mockResolvedValue({
      data: {
        properties: { hashed_token: "hash" },
        user: { id: "auth-ada", email_confirmed_at: "2026-09-23T00:00:00Z" },
      },
      error: null,
    });

    expect(await (await register()).json()).toEqual({ status: "signed-in" });
    expect(appEmail.sendSignupConfirmationEmail).not.toHaveBeenCalled();
  });

  it("reports a failed send as a 502, so the page does not say 'check your email'", async () => {
    appEmail.sendSignupConfirmationEmail.mockResolvedValue({
      ok: false,
      reason: "resend 403: domain is not verified",
    });

    const res = await register();

    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("domain is not verified");
  });

  it("validates the body", async () => {
    const res = await register({ password: "abc", email: "not-an-email" });

    expect(res.status).toBe(400);
    expect(authAdmin.generateLink).not.toHaveBeenCalled();
  });

  describe("without app email", () => {
    beforeEach(() => {
      appEmail.configured = false;
    });

    it("signs up through Supabase's mailer, with the callback as the redirect", async () => {
      serverAuth.signUp.mockResolvedValue({
        data: { user: { id: "auth-ada", identities: [{ id: "i" }] }, session: null },
        error: null,
      });

      expect(await (await register()).json()).toEqual({ status: "sent" });
      expect(serverAuth.signUp).toHaveBeenCalledWith({
        email: "ada@example.com",
        password: "hunter22",
        options: {
          emailRedirectTo: "http://localhost/auth/callback?next=/onboarding",
          data: { full_name: "Ada Lovelace", company_name: "Analytical Engines" },
        },
      });
      expect(authAdmin.generateLink).not.toHaveBeenCalled();
    });

    it("reads Supabase's enumeration guard as 'exists'", async () => {
      // An existing confirmed address comes back as a user with no identities.
      serverAuth.signUp.mockResolvedValue({
        data: { user: { id: "auth-ada", identities: [] }, session: null },
        error: null,
      });

      expect(await (await register()).json()).toEqual({ status: "exists" });
    });

    it("is signed in at once when confirmations are off", async () => {
      serverAuth.signUp.mockResolvedValue({
        data: { user: { id: "auth-ada", identities: [{ id: "i" }] }, session: { access_token: "t" } },
        error: null,
      });

      expect(await (await register()).json()).toEqual({ status: "signed-in" });
    });
  });
});
