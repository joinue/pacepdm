import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceClient: vi.fn() }));

import { appEmailConfigured, sendInviteEmail } from "./send";

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
});
