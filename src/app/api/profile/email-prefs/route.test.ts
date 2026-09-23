import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createFakeSupabase, type FakeSupabase } from "@/lib/__mocks__/fake-supabase";
import { NOTIFICATION_TYPES } from "@/lib/notification-types";

/**
 * Round trip: what the profile page saves is what it reads back. The PATCH
 * schema used to list the types by hand, and Zod strips keys it does not
 * know, so "leadtime" unticked was saved with a success toast, dropped, and
 * merged back in as its default (on) on the next read.
 */

const state = vi.hoisted(() => ({
  fake: null as unknown as FakeSupabase,
  user: { id: "user-1", tenantId: "tenant-1", role: { permissions: [] as string[] } },
}));

vi.mock("@/lib/db", () => ({ getServiceClient: () => state.fake.client }));
vi.mock("@/lib/auth", () => ({ getApiTenantUser: () => Promise.resolve(state.user) }));

import { GET, PATCH } from "./route";

const ctx = { params: Promise.resolve({}) };
const get = () => GET(new NextRequest("http://localhost/api/profile/email-prefs"), ctx);
const patch = (body: unknown) =>
  PATCH(
    new NextRequest("http://localhost/api/profile/email-prefs", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx
  );

beforeEach(() => {
  state.fake = createFakeSupabase({
    tenant_users: [{ id: "user-1", tenantId: "tenant-1", emailPrefs: null }],
  });
});

describe("/api/profile/email-prefs", () => {
  it("reads every type, with its default, when nothing is saved", async () => {
    const { prefs } = await (await get()).json();
    expect(Object.keys(prefs).sort()).toEqual([...NOTIFICATION_TYPES].sort());
    expect(prefs.approval).toBe(true);
    expect(prefs.system).toBe(false);
  });

  it("keeps every type the profile page can send, including the newest", async () => {
    const off = Object.fromEntries(NOTIFICATION_TYPES.map((t) => [t, false]));
    const res = await patch(off);

    expect(res.status).toBe(200);
    const { prefs } = await (await get()).json();
    for (const t of NOTIFICATION_TYPES) expect(prefs[t]).toBe(false);
  });

  it("leaves alone a preference the client did not send", async () => {
    state.fake.tables.tenant_users[0].emailPrefs = { leadtime: false };

    await patch({ approval: false });

    const { prefs } = await (await get()).json();
    expect(prefs).toMatchObject({ approval: false, leadtime: false, eco: true });
  });

  it("rejects a value that is not a boolean", async () => {
    expect((await patch({ approval: "yes" })).status).toBe(400);
  });
});
