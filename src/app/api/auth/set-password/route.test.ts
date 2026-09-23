import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createFakeSupabase, type FakeSupabase } from "@/lib/__mocks__/fake-supabase";

/**
 * Setting a password is what accepts an invitation — on /accept-invite, and
 * just as much on /reset-password for an invitee whose link expired and who
 * used "Forgot password?" instead.
 */

const state = vi.hoisted(() => ({
  fake: null as unknown as FakeSupabase,
  session: { id: "auth-pat" } as { id: string } | null,
  updateUser: vi.fn(),
}));

const audit = vi.hoisted(() => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@/lib/db", () => ({ getServiceClient: () => state.fake.client }));
vi.mock("@/lib/audit", () => audit);
vi.mock("@/lib/auth", () => ({ getSession: () => Promise.resolve(state.session) }));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => ({ auth: { updateUser: state.updateUser } }),
}));

import { POST } from "./route";

const setPassword = (password: unknown) =>
  POST(
    new NextRequest("http://localhost/api/auth/set-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    })
  );

beforeEach(() => {
  state.session = { id: "auth-pat" };
  state.updateUser.mockReset().mockResolvedValue({ data: {}, error: null });
  audit.logAudit.mockClear();
  state.fake = createFakeSupabase({
    tenant_users: [
      { id: "tu-1", tenantId: "tenant-1", authUserId: "auth-pat", acceptedAt: null },
      { id: "tu-2", tenantId: "tenant-2", authUserId: "auth-other", acceptedAt: null },
      { id: "tu-3", tenantId: "tenant-3", authUserId: "auth-pat", acceptedAt: "2026-01-01T00:00:00Z" },
    ],
  });
});

describe("POST /api/auth/set-password", () => {
  it("sets the password and marks the caller's pending invitation accepted", async () => {
    const res = await setPassword("hunter22");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: true });
    expect(state.updateUser).toHaveBeenCalledWith({ password: "hunter22" });

    const rows = state.fake.rows("tenant_users");
    expect(rows[0].acceptedAt).toEqual(expect.any(String));
    // Someone else's pending row, and an already-accepted row, are untouched.
    expect(rows[1].acceptedAt).toBeNull();
    expect(rows[2].acceptedAt).toBe("2026-01-01T00:00:00Z");

    expect(audit.logAudit).toHaveBeenCalledTimes(1);
    expect(audit.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-1", action: "user.invite_accepted" })
    );
  });

  it("is a plain password change for someone with nothing pending", async () => {
    state.fake.rows("tenant_users")[0].acceptedAt = "2026-05-05T00:00:00Z";

    const res = await setPassword("hunter22");

    expect(await res.json()).toEqual({ ok: true, accepted: false });
    expect(audit.logAudit).not.toHaveBeenCalled();
  });

  it("answers 401, with what to do, when there is no session", async () => {
    state.session = null;

    const res = await setPassword("hunter22");

    expect(res.status).toBe(401);
    expect((await res.json()).error).toContain("Open the link from your email again");
    expect(state.updateUser).not.toHaveBeenCalled();
  });

  it("surfaces Supabase's refusal and stamps nothing", async () => {
    state.updateUser.mockResolvedValue({
      data: null,
      error: { message: "New password should be different from the old password." },
    });

    const res = await setPassword("hunter22");

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("different from the old password");
    expect(state.fake.rows("tenant_users")[0].acceptedAt).toBeNull();
  });

  it("rejects a short password before touching anything", async () => {
    const res = await setPassword("abc");

    expect(res.status).toBe(400);
    expect(state.updateUser).not.toHaveBeenCalled();
  });
});
