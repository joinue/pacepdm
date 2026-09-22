import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createFakeSupabase, type FakeSupabase } from "@/lib/__mocks__/fake-supabase";

/**
 * Equipment lead times. Sales reads the page with no permission beyond a
 * session — a lead-time list sales cannot open is the spreadsheet again —
 * while stating a lead time needs `leadtime.edit`, and every change is kept.
 */

const state = vi.hoisted(() => ({
  fake: null as unknown as FakeSupabase,
  user: null as null | Record<string, unknown>,
}));

vi.mock("@/lib/db", () => ({ getServiceClient: () => state.fake.client }));
vi.mock("@/lib/auth", () => ({ getApiTenantUser: () => Promise.resolve(state.user) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/notifications", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
  sideEffect: (p: Promise<unknown>) => p,
}));

import { GET, POST } from "./route";
import { PUT, GET as HISTORY } from "./[leadTimeId]/route";
import { logAudit } from "@/lib/audit";
import { notify } from "@/lib/notifications";

const TENANT = "tenant-1";
const ROW_ID = "11111111-1111-4111-8111-111111111111";
const params = { params: Promise.resolve({ leadTimeId: ROW_ID }) };

const engineer = {
  id: "user-1",
  tenantId: TENANT,
  fullName: "Alice",
  roleId: "role-eng",
  role: { permissions: ["leadtime.edit"] },
};
const salesperson = {
  ...engineer,
  id: "user-2",
  fullName: "Sam",
  role: { permissions: ["file.view"] },
};

function req(method: string, body?: unknown) {
  return new NextRequest("http://localhost/api/lead-times", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const rows = () => state.fake.rows("equipment_lead_times");
const changes = () => state.fake.rows("equipment_lead_time_changes");

beforeEach(() => {
  vi.clearAllMocks();
  state.user = engineer;
  state.fake = createFakeSupabase({
    equipment_lead_times: [
      {
        id: ROW_ID,
        tenantId: TENANT,
        model: "MEGA-T300A",
        description: 'Automated Abrasive Cutter - 12"',
        typicalLeadTime: "4 weeks",
        currentLeadTime: null,
        notes: null,
        updatedById: null,
        updatedAt: null,
        deletedAt: null,
      },
    ],
    equipment_lead_time_changes: [],
    tenant_users: [
      { id: "user-1", tenantId: TENANT, fullName: "Alice", isActive: true },
      { id: "user-2", tenantId: TENANT, fullName: "Sam", isActive: true },
      { id: "user-3", tenantId: TENANT, fullName: "Gone", isActive: false },
      { id: "user-9", tenantId: "tenant-OTHER", fullName: "Someone else", isActive: true },
    ],
  });
});

describe("GET /api/lead-times", () => {
  it("lists the equipment for anyone signed in, because sales holds Viewer", async () => {
    state.user = salesperson;
    const res = await GET(req("GET"), { params: Promise.resolve({}) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.leadTimes).toHaveLength(1);
    expect(body.leadTimes[0]).toMatchObject({ model: "MEGA-T300A", typicalLeadTime: "4 weeks" });
    expect(body.options).toContain("6-8 weeks");
  });

  it("does not show another workspace's equipment", async () => {
    state.fake.tables.equipment_lead_times[0].tenantId = "tenant-OTHER";
    const body = await (await GET(req("GET"), { params: Promise.resolve({}) })).json();
    expect(body.leadTimes).toHaveLength(0);
  });

  it("401s without a session", async () => {
    state.user = null;
    expect((await GET(req("GET"), { params: Promise.resolve({}) })).status).toBe(401);
  });
});

describe("PUT /api/lead-times/[leadTimeId]", () => {
  it("states the lead time, stamping who said it and when", async () => {
    const res = await PUT(req("PUT", { currentLeadTime: "6-8 weeks" }), params);

    expect(res.status).toBe(200);
    expect(rows()[0]).toMatchObject({ currentLeadTime: "6-8 weeks", updatedById: "user-1" });
    expect(rows()[0].updatedAt).toBeTruthy();
  });

  it("keeps what the value was, which a spreadsheet overwrites", async () => {
    state.fake.tables.equipment_lead_times[0].currentLeadTime = "4 weeks";

    await PUT(req("PUT", { currentLeadTime: "10-12 weeks", notes: "Casting delay" }), params);

    expect(changes()).toHaveLength(1);
    expect(changes()[0]).toMatchObject({
      leadTimeId: ROW_ID,
      fromLeadTime: "4 weeks",
      toLeadTime: "10-12 weeks",
      note: "Casting delay",
      changedById: "user-1",
    });
  });

  it("does not record history for a note that leaves the lead time alone", async () => {
    await PUT(req("PUT", { notes: "Ask the shop" }), params);
    expect(rows()[0].notes).toBe("Ask the shop");
    expect(changes()).toHaveLength(0);
  });

  it("refuses a lead time that is not one of the options, naming them", async () => {
    const res = await PUT(req("PUT", { currentLeadTime: "about a month" }), params);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/not one of the lead times sales quotes/);
    expect(body.details.options).toContain("In Stock");
    expect(rows()[0].currentLeadTime).toBeNull();
  });

  it("refuses someone who can only read", async () => {
    state.user = salesperson;
    expect((await PUT(req("PUT", { currentLeadTime: "In Stock" }), params)).status).toBe(403);
    expect(rows()[0].currentLeadTime).toBeNull();
  });

  it("404s equipment in another workspace", async () => {
    state.fake.tables.equipment_lead_times[0].tenantId = "tenant-OTHER";
    expect((await PUT(req("PUT", { currentLeadTime: "In Stock" }), params)).status).toBe(404);
  });

  it("tells the workspace, which is what sales asked for", async () => {
    await PUT(req("PUT", { currentLeadTime: "6-8 weeks", notes: "Casting delay" }), params);

    expect(notify).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(notify).mock.calls[0][0];
    // Active people in this workspace. notify() drops the actor itself.
    expect(sent.userIds.sort()).toEqual(["user-1", "user-2"]);
    expect(sent).toMatchObject({ type: "leadtime", link: "/lead-times", actorId: "user-1" });
    expect(sent.title).toBe("MEGA-T300A: 6-8 weeks");
    expect(sent.message).toMatch(
      /Alice changed the MEGA-T300A lead time from not set to 6-8 weeks/
    );
    expect(sent.message).toMatch(/Casting delay/);
  });

  it("says nothing when only a note changed", async () => {
    await PUT(req("PUT", { notes: "Ask the shop" }), params);
    expect(notify).not.toHaveBeenCalled();
  });

  it("records the change in the audit log", async () => {
    await PUT(req("PUT", { currentLeadTime: "In Stock" }), params);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "leadtime.update",
        details: { model: "MEGA-T300A", from: null, to: "In Stock" },
      })
    );
  });
});

describe("POST /api/lead-times", () => {
  it("adds a model", async () => {
    const res = await POST(
      req("POST", { model: "PICO-250", description: "New saw", typicalLeadTime: "4 weeks" }),
      { params: Promise.resolve({}) }
    );

    expect(res.status).toBe(200);
    expect(rows().map((r) => r.model)).toContain("PICO-250");
  });

  it("refuses a model already on the list, whatever the case", async () => {
    const res = await POST(req("POST", { model: "mega-t300a" }), { params: Promise.resolve({}) });
    expect(res.status).toBe(409);
    expect(rows()).toHaveLength(1);
  });

  it("refuses someone who can only read", async () => {
    state.user = salesperson;
    const res = await POST(req("POST", { model: "PICO-250" }), { params: Promise.resolve({}) });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/lead-times/[leadTimeId]", () => {
  it("returns the history, newest first, for anyone signed in", async () => {
    state.user = salesperson;
    state.fake.tables.equipment_lead_time_changes = [
      {
        id: "c-1",
        tenantId: TENANT,
        leadTimeId: ROW_ID,
        fromLeadTime: "4 weeks",
        toLeadTime: "6-8 weeks",
        note: null,
        changedById: "user-1",
        changedAt: "2026-09-01T00:00:00Z",
      },
    ];

    const res = await HISTORY(req("GET"), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.model).toBe("MEGA-T300A");
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]).toMatchObject({ fromLeadTime: "4 weeks", toLeadTime: "6-8 weeks" });
  });
});
