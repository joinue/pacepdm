import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createFakeSupabase, type FakeSupabase } from "@/lib/__mocks__/fake-supabase";

/**
 * The two settings the email sender reads. `emailReplyTo` was read by the
 * sender but not allow-listed here, and a save replaces the whole settings
 * object — so it was wiped by any visit to the settings page.
 */

const state = vi.hoisted(() => ({
  fake: null as unknown as FakeSupabase,
  user: {
    id: "user-1",
    tenantId: "tenant-1",
    fullName: "Ada",
    role: { permissions: ["admin.settings"] },
  },
}));

vi.mock("@/lib/db", () => ({ getServiceClient: () => state.fake.client }));
vi.mock("@/lib/auth", () => ({ getApiTenantUser: () => Promise.resolve(state.user) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import { PUT } from "./route";

const ctx = { params: Promise.resolve({}) };
const put = (settings: Record<string, unknown>) =>
  PUT(
    new NextRequest("http://localhost/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Acme", settings }),
    }),
    ctx
  );
const saved = () => state.fake.tables.tenants[0].settings as Record<string, unknown>;

beforeEach(() => {
  state.fake = createFakeSupabase({
    tenants: [{ id: "tenant-1", name: "Acme", settings: { emailNotifications: true } }],
  });
});

describe("PUT /api/settings", () => {
  it("keeps the reply-to address across a save", async () => {
    const res = await put({ emailNotifications: true, emailReplyTo: "eng@acme.test" });

    expect(res.status).toBe(200);
    expect(saved()).toMatchObject({ emailNotifications: true, emailReplyTo: "eng@acme.test" });
  });

  it("treats an empty reply-to as none", async () => {
    await put({ emailReplyTo: " " });
    expect(saved()).not.toHaveProperty("emailReplyTo");
  });

  it("refuses a reply-to that is not an address", async () => {
    const res = await put({ emailReplyTo: "engineering" });

    expect(res.status).toBe(400);
    expect((await res.json()).details).toHaveProperty("emailReplyTo");
    expect(saved()).toEqual({ emailNotifications: true });
  });

  it("refuses the tenant opt-out as anything but a boolean", async () => {
    // The sender checks `=== false`, so the string "false" would opt nobody out.
    expect((await put({ emailNotifications: "false" })).status).toBe(400);
  });

  it("drops keys it does not know, including the digest setting nothing reads", async () => {
    await put({ emailNotifications: false, digestFrequency: "DAILY", isAdmin: true });
    expect(saved()).toEqual({ emailNotifications: false });
  });
});
