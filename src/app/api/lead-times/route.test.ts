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
import { POST as FLAG, DELETE as UNFLAG } from "./[leadTimeId]/flag/route";
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
/** Read-only everywhere, and can ask for a lead time to be confirmed. */
const salesperson = {
  ...engineer,
  id: "user-2",
  fullName: "Sam",
  roleId: "role-sales",
  role: { permissions: ["file.view", "leadtime.flag"] },
};
/** Sales, plus the note beside the answer. */
const salesManager = {
  ...salesperson,
  id: "user-4",
  fullName: "Dana",
  roleId: "role-sales-manager",
  role: { permissions: ["file.view", "leadtime.flag", "leadtime.note"] },
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
      { id: "user-1", tenantId: TENANT, fullName: "Alice", roleId: "role-eng", isActive: true },
      { id: "user-2", tenantId: TENANT, fullName: "Sam", roleId: "role-sales", isActive: true },
      { id: "user-3", tenantId: TENANT, fullName: "Gone", roleId: "role-eng", isActive: false },
      { id: "user-5", tenantId: TENANT, fullName: "Ada", roleId: "role-admin", isActive: true },
      {
        id: "user-9",
        tenantId: "tenant-OTHER",
        fullName: "Someone else",
        roleId: "role-eng",
        isActive: true,
      },
    ],
    roles: [
      { id: "role-eng", tenantId: TENANT, name: "Engineer", permissions: ["leadtime.edit"] },
      { id: "role-admin", tenantId: TENANT, name: "Admin", permissions: ["*"] },
      { id: "role-sales", tenantId: TENANT, name: "Sales", permissions: ["leadtime.flag"] },
      {
        id: "role-sales-manager",
        tenantId: TENANT,
        name: "Sales Manager",
        permissions: ["leadtime.flag", "leadtime.note"],
      },
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
    // Every active person in this workspace, whatever their role — sales hears
    // it, and so does everyone else. notify() drops the actor itself.
    expect(sent.userIds.sort()).toEqual(["user-1", "user-2", "user-5"]);
    expect(sent).toMatchObject({ type: "leadtime", link: "/lead-times", actorId: "user-1" });
    expect(sent.title).toBe("MEGA-T300A: 6-8 weeks");
    expect(sent.message).toMatch(
      /Alice changed the MEGA-T300A lead time from not set to 6-8 weeks/
    );
    expect(sent.message).toMatch(/Casting delay/);
  });

  it("changes the baseline quietly — nothing is quoted from it", async () => {
    const res = await PUT(req("PUT", { typicalLeadTime: "6-8 weeks" }), params);

    expect(res.status).toBe(200);
    expect(rows()[0].typicalLeadTime).toBe("6-8 weeks");
    expect(changes()).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
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

/**
 * Sales can read the page and not change it, so asking "is six weeks still
 * right?" had to happen by email — the habit this page replaces.
 */
describe("flagging a lead time for a check", () => {
  it("marks the machine and tells everyone who can answer", async () => {
    state.user = salesperson;

    const res = await FLAG(req("POST", { reason: "Quoting Acme Friday" }), params);

    expect(res.status).toBe(200);
    expect(rows()[0]).toMatchObject({ flaggedById: "user-2", flagReason: "Quoting Acme Friday" });
    expect(rows()[0].flaggedAt).toBeTruthy();

    const sent = vi.mocked(notify).mock.calls[0][0];
    // The engineer and the admin — not the other salesperson, and not the
    // deactivated user.
    expect(sent.userIds.sort()).toEqual(["user-1", "user-5"]);
    expect(sent.message).toMatch(/Sam asked for the MEGA-T300A lead time to be confirmed/);
    expect(sent.message).toMatch(/Quoting Acme Friday/);
  });

  it("refuses someone with no flag permission", async () => {
    state.user = { ...salesperson, role: { permissions: ["file.view"] } };
    expect((await FLAG(req("POST", {}), params)).status).toBe(403);
    expect(rows()[0].flaggedAt).toBeFalsy();
  });

  it("will not flag the same machine twice", async () => {
    state.user = salesperson;
    await FLAG(req("POST", {}), params);
    const again = await FLAG(req("POST", {}), params);
    expect(again.status).toBe(409);
  });

  it("clears the flag when the lead time is set, since that is the answer", async () => {
    state.fake.tables.equipment_lead_times[0].flaggedAt = "2026-09-20T00:00:00Z";
    state.fake.tables.equipment_lead_times[0].flaggedById = "user-2";
    state.fake.tables.equipment_lead_times[0].flagReason = "Quoting Acme";

    await PUT(req("PUT", { currentLeadTime: "6-8 weeks" }), params);

    expect(rows()[0].flaggedAt).toBeNull();
    expect(rows()[0].flagReason).toBeNull();
  });

  it("lets someone who can answer drop the flag without changing the number", async () => {
    state.fake.tables.equipment_lead_times[0].flaggedAt = "2026-09-20T00:00:00Z";
    const res = await UNFLAG(req("DELETE"), params);
    expect(res.status).toBe(200);
    expect(rows()[0].flaggedAt).toBeNull();
  });

  it("does not let sales clear their own flag — the point is that it is answered", async () => {
    state.fake.tables.equipment_lead_times[0].flaggedAt = "2026-09-20T00:00:00Z";
    state.user = salesperson;
    expect((await UNFLAG(req("DELETE"), params)).status).toBe(403);
    expect(rows()[0].flaggedAt).toBeTruthy();
  });
});

describe("a sales manager's note", () => {
  it("writes the note beside a lead time", async () => {
    state.user = salesManager;
    const res = await PUT(req("PUT", { notes: "Acme asked for a firm date" }), params);
    expect(res.status).toBe(200);
    expect(rows()[0].notes).toBe("Acme asked for a firm date");
  });

  it("still cannot set the lead time itself", async () => {
    state.user = salesManager;
    const res = await PUT(req("PUT", { currentLeadTime: "In Stock" }), params);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/flag the machine instead/);
    expect(rows()[0].currentLeadTime).toBeNull();
  });

  it("refuses a note from plain sales", async () => {
    state.user = salesperson;
    expect((await PUT(req("PUT", { notes: "nope" }), params)).status).toBe(403);
  });
});
