import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createFakeSupabase, type FakeSupabase } from "@/lib/__mocks__/fake-supabase";

/**
 * Implementing an ECO. `implement_eco` skipped, without a word, files it did
 * not find in WIP or found checked out, and released files and parts from the
 * trash — while the ECO went to IMPLEMENTED, the toast counted what it did,
 * and every file on the ECO was announced as released (AUD-003 CHG-2).
 */

const state = vi.hoisted(() => ({
  fake: null as unknown as FakeSupabase,
  user: null as null | {
    id: string;
    tenantId: string;
    fullName: string;
    roleId: string;
    role: { permissions: string[] };
  },
}));

vi.mock("@/lib/db", () => ({ getServiceClient: () => state.fake.client }));
vi.mock("@/lib/auth", () => ({ getApiTenantUser: () => Promise.resolve(state.user) }));
vi.mock("@/lib/releases", () => ({
  createReleaseFromEco: vi.fn().mockResolvedValue({
    id: "rel-1",
    manifest: { parts: [], files: [], boms: [] },
  }),
}));
vi.mock("@/lib/notifications", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
  sideEffect: (p: Promise<unknown>) => p,
}));

import { POST } from "./route";
import { notify } from "@/lib/notifications";

const TENANT = "tenant-a";
const ECO_ID = "e0e0e0e0-1111-4111-8111-000000000001";
const params = { params: Promise.resolve({ ecoId: ECO_ID }) };

function file(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    tenantId: TENANT,
    name: `${id}.SLDDRW`,
    lifecycleState: "WIP",
    isCheckedOut: false,
    deletedAt: null,
    createdById: "user-9",
    checkedOutBy: null,
    ...extra,
  };
}

const implement = () =>
  POST(
    new NextRequest(`http://localhost/api/ecos/${ECO_ID}/implement`, { method: "POST" }),
    params
  );

beforeEach(() => {
  vi.clearAllMocks();
  state.user = {
    id: "user-1",
    tenantId: TENANT,
    fullName: "Alice",
    roleId: "role-eng",
    role: { permissions: ["eco.edit"] },
  };
  state.fake = createFakeSupabase({
    ecos: [
      {
        id: ECO_ID,
        tenantId: TENANT,
        ecoNumber: "ECO-0042",
        title: "Bracket change",
        status: "APPROVED",
        createdById: "user-9",
        deletedAt: null,
      },
    ],
    eco_items: [
      { id: "i-1", ecoId: ECO_ID, fileId: "bracket", partId: null, toRevision: null },
      { id: "i-2", ecoId: ECO_ID, fileId: "released-already", partId: null, toRevision: null },
    ],
    files: [file("bracket"), file("released-already", { lifecycleState: "Released" })],
    tenant_users: [
      { id: "user-1", tenantId: TENANT, isActive: true },
      { id: "user-9", tenantId: TENANT, isActive: true },
      { id: "user-gone", tenantId: TENANT, isActive: false },
      { id: "user-other", tenantId: "tenant-b", isActive: true },
    ],
  });
  state.fake.rpcResults.implement_eco = {
    data: { success: true, filesTransitioned: 1, partsReleased: 0, bomsReleased: 0 },
    error: null,
  };
});

describe("POST /api/ecos/[ecoId]/implement", () => {
  it("implements, and tells the workspace once, counting only the files that moved", async () => {
    const res = await implement();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ filesTransitioned: 1, releaseId: "rel-1" });
    expect(state.fake.rpcCalls).toEqual([
      { fn: "implement_eco", args: { p_eco_id: ECO_ID, p_user_id: "user-1" } },
    ]);
    // One notification for the whole implementation, not one per released
    // file through the Released broadcast. Active members of this tenant
    // only; notify() drops the actor itself.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "eco",
        userIds: ["user-1", "user-9"],
        actorId: "user-1",
        refId: ECO_ID,
        link: `/ecos/${ECO_ID}`,
        message: "Alice implemented ECO-0042: Bracket change — 1 file released",
      })
    );
  });

  it("refuses, without implementing, while a file it would release is checked out", async () => {
    Object.assign(state.fake.tables.files[0], {
      isCheckedOut: true,
      checkedOutBy: { fullName: "Bob" },
    });

    const res = await implement();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(
      /ECO-0042 cannot be implemented yet: bracket.SLDDRW is checked out by Bob/
    );
    expect(body.details.blockers).toHaveLength(1);
    expect(state.fake.rpcCalls).toHaveLength(0);
  });

  it("refuses a file in the trash instead of releasing it from there", async () => {
    state.fake.tables.files[0].deletedAt = "2026-09-01T00:00:00Z";
    const res = await implement();
    expect(res.status).toBe(409);
    expect(state.fake.rpcCalls).toHaveLength(0);
  });

  it("refuses an ECO that is not approved", async () => {
    state.fake.tables.ecos[0].status = "IN_REVIEW";
    expect((await implement()).status).toBe(400);
  });

  it("404s an ECO in another tenant", async () => {
    state.fake.tables.ecos[0].tenantId = "tenant-b";
    expect((await implement()).status).toBe(404);
    expect(state.fake.rpcCalls).toHaveLength(0);
  });

  it("writes the revision a part becomes before implementing, for an ECO submitted without one", async () => {
    state.fake.tables.eco_items.push({
      id: "i-3",
      ecoId: ECO_ID,
      fileId: null,
      partId: "part-1",
      toRevision: null,
    });
    state.fake.tables.parts = [
      { id: "part-1", tenantId: TENANT, partNumber: "PN-1042", revision: "R3", deletedAt: null },
    ];

    const res = await implement();

    expect(res.status).toBe(200);
    // R3 made the old bump raise, leaving the ECO stuck (AUD-003 CHG-3).
    expect(state.fake.tables.eco_items.find((i) => i.id === "i-3")?.toRevision).toBe("R4");
    expect(state.fake.rpcCalls).toHaveLength(1);
  });

  it("refuses a part whose revision cannot be followed on from, pointing at the way back", async () => {
    state.fake.tables.eco_items.push({
      id: "i-3",
      ecoId: ECO_ID,
      fileId: null,
      partId: "part-1",
      toRevision: null,
    });
    state.fake.tables.parts = [
      { id: "part-1", tenantId: TENANT, partNumber: "PN-1042", revision: "Z", deletedAt: null },
    ];

    const res = await implement();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Have an approver reject the ECO/);
    expect(state.fake.rpcCalls).toHaveLength(0);
  });

  it("surfaces the database function's own refusal", async () => {
    state.fake.rpcResults.implement_eco = {
      data: null,
      error: {
        message: "ECO ECO-0042 would release part PN-1 as revision C, which it is already at.",
      },
    };
    const res = await implement();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/which it is already at/);
  });
});
