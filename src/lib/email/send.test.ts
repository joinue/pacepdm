import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceClient: vi.fn() }));

import {
  appBaseUrl,
  appEmailConfigured,
  sendInviteEmail,
  sendSignupConfirmationEmail,
} from "./send";

const invite = {
  to: "pat@example.com",
  recipientName: "Pat Lee",
  inviterName: "Alice",
  tenantId: "tenant-1",
  tenantName: "Acme <Robotics>",
  link: "https://app.example.com/auth/confirm?token_hash=abc&type=invite&next=%2Faccept-invite",
};

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM", "PACE PDM <noreply@example.com>");
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("sendInviteEmail", () => {
  it("sends the app-built link to the invitee through Resend", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));

    const result = await sendInviteEmail(invite);

    expect(result).toEqual({ ok: true, providerId: "email-1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(init.body);
    expect(body.to).toEqual(["pat@example.com"]);
    expect(body.subject).toBe("Alice invited you to Acme <Robotics> on PACE PDM");
    expect(body.text).toContain(invite.link);
    // The link survives HTML escaping intact apart from its ampersands.
    expect(body.html).toContain(invite.link.replace(/&/g, "&amp;"));
    expect(body.html).toContain("Acme &lt;Robotics&gt;");
    expect(body.html).not.toContain("<Robotics>");
  });

  it("reports the provider's reason when Resend refuses the send", async () => {
    fetchMock.mockResolvedValue(new Response("domain is not verified", { status: 403 }));

    const result = await sendInviteEmail(invite);

    expect(result).toEqual({ ok: false, reason: "resend 403: domain is not verified" });
  });

  it("sends nothing when app email is not configured", async () => {
    vi.stubEnv("RESEND_API_KEY", "");

    expect(appEmailConfigured()).toBe(false);
    expect(await sendInviteEmail(invite)).toMatchObject({ ok: false, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tells someone who already has an account that their password works, and why there is a link", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "email-2" }), { status: 200 }));

    await sendInviteEmail({ ...invite, existingAccount: true });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.subject).toBe("Alice added you to Acme <Robotics> on PACE PDM");
    expect(body.text).toContain("sign in with your existing password");
    expect(body.text).toContain("never set one");
    expect(body.text).toContain(invite.link);
  });
});

describe("sendSignupConfirmationEmail", () => {
  it("sends the app-built confirmation link, and says it works on any device", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "email-3" }), { status: 200 }));

    const result = await sendSignupConfirmationEmail({
      to: "ada@example.com",
      recipientName: "Ada Lovelace",
      link: "https://app.example.com/auth/confirm?token_hash=abc&type=signup&next=%2Fonboarding",
    });

    expect(result).toEqual({ ok: true, providerId: "email-3" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.to).toEqual(["ada@example.com"]);
    expect(body.subject).toMatch(/Confirm your email/);
    expect(body.text).toContain("Hi Ada,");
    expect(body.text).toContain("any device");
    expect(body.text).toContain("token_hash=abc");
    expect(body.tags).toEqual([{ name: "type", value: "signup" }]);
  });
});

/**
 * Resend allows 2 requests a second by default. An approval request to a group
 * of four used to send four emails at once, and the refused ones were never
 * retried, so some approvers were simply never told.
 */
describe("rate limiting", () => {
  it("retries a 429 and reports the send that then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response("rate limited", { status: 429, headers: { "retry-after": "0" } })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "email-2" }), { status: 200 }));

    const result = await sendInviteEmail(invite);

    expect(result).toEqual({ ok: true, providerId: "email-2" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after three attempts and reports the 429", async () => {
    fetchMock.mockImplementation(
      async () => new Response("rate limited", { status: 429, headers: { "retry-after": "0" } })
    );

    const result = await sendInviteEmail(invite);

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("resend 429") });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a refusal that waiting will not fix", async () => {
    fetchMock.mockResolvedValue(new Response("domain is not verified", { status: 403 }));

    await sendInviteEmail(invite);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Links in notification emails are built from this. The README tells people to
 * set NEXT_PUBLIC_APP_URL for emails, but only APP_URL was read, so with the
 * documented variable alone every button in every email was a dead relative
 * link.
 */
describe("appBaseUrl", () => {
  it("prefers APP_URL", () => {
    vi.stubEnv("APP_URL", "https://app.example.com");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://other.example.com");
    expect(appBaseUrl()).toBe("https://app.example.com");
  });

  it("falls back to NEXT_PUBLIC_APP_URL", () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com/");
    expect(appBaseUrl()).toBe("https://app.example.com");
  });
});
