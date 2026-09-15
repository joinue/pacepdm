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
  notifyFileTransition: vi.fn().mockResolvedValue(undefined),
  sideEffect: (p: Promise<unknown>) => p,
}));

import { POST } from "./route";
import { notifyFileTransition } from "@/lib/notifications";

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
      { id: "i-1", ecoId: ECO_ID, fileId: "bracket", partId: null },
      { id: "i-2", ecoId: ECO_ID, fileId: "released-already", partId: null },
    ],
    files: [file("bracket"), file("released-already", { lifecycleState: "Released" })],
  });
  state.fake.rpcResults.implement_eco = {
    data: { success: true, filesTransitioned: 1, partsReleased: 0, bomsReleased: 0 },
    error: null,
  };
});

describe("POST /api/ecos/[ecoId]/implement", () => {
  it("implements, and announces only the file that actually moved to Released", async () => {
    const res = await implement();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ filesTransitioned: 1, releaseId: "rel-1" });
    expect(state.fake.rpcCalls).toEqual([
      { fn: "implement_eco", args: { p_eco_id: ECO_ID, p_user_id: "user-1" } },
    ]);
    expect(notifyFileTransition).toHaveBeenCalledTimes(1);
    expect(notifyFileTransition).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: "bracket", toStateName: "Released" })
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

  it("surfaces the database function's own refusal", async () => {
    state.fake.rpcResults.implement_eco = {
      data: null,
      error: { message: 'Cannot auto-bump revision for part PN-1 (current rev: "R3")' },
    };
    const res = await implement();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Cannot auto-bump revision/);
  });
});
