import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createFakeSupabase, type FakeSupabase } from "@/lib/__mocks__/fake-supabase";

/**
 * `eco_items` can point at a part, a file, or — since migration 046 — a BOM.
 * Exactly one, enforced by a CHECK in the database and a `.refine()` on the
 * schema, because an ECO item pointing at two things has no defined meaning on
 * implement. A part item's revision is checked as it is added: an explicit one
 * was never checked, and a blank one was left for `implement_eco` to bump in a
 * way that stranded approved ECOs (AUD-003 CHG-3).
 */

const state = vi.hoisted(() => ({
  fake: null as unknown as FakeSupabase,
  user: null as null | Record<string, unknown>,
}));

vi.mock("@/lib/db", () => ({ getServiceClient: () => state.fake.client }));
vi.mock("@/lib/auth", () => ({ getApiTenantUser: () => Promise.resolve(state.user) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import { GET, POST, DELETE } from "./route";

const TENANT = "tenant-1";
const ECO_ID = "11111111-1111-4111-8111-111111111111";
const BOM_ID = "22222222-2222-4222-8222-222222222222";
const PART_ID = "33333333-3333-4333-8333-333333333333";
const params = { params: Promise.resolve({ ecoId: ECO_ID }) };

function req(method: string, body?: unknown) {
  return new NextRequest(`http://localhost/api/ecos/${ECO_ID}/items`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const add = (body: unknown) => POST(req("POST", body), params);
const items = () => state.fake.rows("eco_items");

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
    ecos: [{ id: ECO_ID, tenantId: TENANT, status: "DRAFT", ecoNumber: "ECO-1", deletedAt: null }],
    boms: [
      {
        id: BOM_ID,
        tenantId: TENANT,
        name: "NANO-1000S",
        revision: "B",
        status: "RELEASED",
        deletedAt: null,
      },
    ],
    parts: [
      {
        id: PART_ID,
        tenantId: TENANT,
        partNumber: "PN-1042",
        name: "Bracket",
        revision: "C",
        lifecycleState: "Released",
        category: "Machined",
        deletedAt: null,
      },
    ],
    eco_items: [],
  });
});

describe("POST /api/ecos/[ecoId]/items — BOM items", () => {
  it("adds a BOM to the ECO and seeds fromRevision from the BOM", async () => {
    const res = await add({ bomId: BOM_ID, changeType: "MODIFY" });
    expect(res.status).toBe(200);
    expect(items()[0]).toMatchObject({
      ecoId: ECO_ID,
      bomId: BOM_ID,
      partId: null,
      fileId: null,
      // Records what the structure looked like before the change.
      fromRevision: "B",
    });
  });

  it("carries an explicit toRevision through", async () => {
    await add({ bomId: BOM_ID, changeType: "MODIFY", toRevision: "C" });
    expect(items()[0].toRevision).toBe("C");
  });

  it("returns 404 for a BOM in another tenant", async () => {
    state.fake.tables.boms[0].tenantId = "tenant-OTHER";
    const res = await add({ bomId: BOM_ID, changeType: "MODIFY" });
    expect(res.status).toBe(404);
    expect(items()).toHaveLength(0);
  });

  it("refuses the same BOM twice on one ECO", async () => {
    state.fake.tables.eco_items = [{ id: "existing", ecoId: ECO_ID, bomId: BOM_ID }];
    const res = await add({ bomId: BOM_ID, changeType: "MODIFY" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already in this eco/i);
  });

  it("requires exactly one target", async () => {
    // Two targets has no defined meaning on implement.
    const both = await add({ bomId: BOM_ID, partId: PART_ID, changeType: "MODIFY" });
    expect(both.status).toBe(400);
    const none = await add({ changeType: "MODIFY" });
    expect(none.status).toBe(400);
    expect(items()).toHaveLength(0);
  });
});

describe("POST /api/ecos/[ecoId]/items — part revisions", () => {
  it("accepts a blank To revision when the next one can be worked out, and leaves it for submit", async () => {
    const res = await add({ partId: PART_ID, changeType: "MODIFY" });
    expect(res.status).toBe(200);
    expect(items()[0]).toMatchObject({ partId: PART_ID, fromRevision: "C", toRevision: null });
    expect((await res.json()).part).toMatchObject({ partNumber: "PN-1042" });
  });

  it("keeps a later explicit revision", async () => {
    const res = await add({ partId: PART_ID, changeType: "MODIFY", toRevision: "E" });
    expect(res.status).toBe(200);
    expect(items()[0].toRevision).toBe("E");
  });

  it("refuses the revision the part is already at", async () => {
    const res = await add({ partId: PART_ID, changeType: "MODIFY", toRevision: "C" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/PN-1042 is already at revision C/);
    expect(items()).toHaveLength(0);
  });

  it("refuses a revision that goes backwards", async () => {
    const res = await add({ partId: PART_ID, changeType: "MODIFY", toRevision: "B" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/B comes before it/);
  });

  it("asks for a revision when it cannot follow on from the current one", async () => {
    // Z is a reserved letter; the old bump raised on it only at implement,
    // after approval, where nothing could be changed.
    state.fake.tables.parts[0].revision = "Z";
    const res = await add({ partId: PART_ID, changeType: "MODIFY" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cannot be followed on from automatically/);

    const withRevision = await add({ partId: PART_ID, changeType: "MODIFY", toRevision: "AA" });
    expect(withRevision.status).toBe(200);
  });

  it("refuses a part in the trash", async () => {
    state.fake.tables.parts[0].deletedAt = "2026-09-01T00:00:00Z";
    expect((await add({ partId: PART_ID, changeType: "MODIFY" })).status).toBe(404);
  });

  it("only adds to a draft ECO", async () => {
    state.fake.tables.ecos[0].status = "APPROVED";
    expect((await add({ partId: PART_ID, changeType: "MODIFY" })).status).toBe(400);
  });
});

describe("GET and DELETE /api/ecos/[ecoId]/items", () => {
  beforeEach(() => {
    state.fake.tables.eco_items = [
      {
        id: "item-1",
        ecoId: ECO_ID,
        partId: PART_ID,
        fileId: null,
        bomId: null,
        changeType: "MODIFY",
        reason: null,
        fromRevision: "C",
        toRevision: "D",
      },
      { id: "other-eco-item", ecoId: "another-eco", partId: PART_ID, fileId: null, bomId: null },
    ];
  });

  it("lists this ECO's items with their parts", async () => {
    const res = await GET(req("GET"), params);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: "item-1", part: { partNumber: "PN-1042" } });
  });

  it("404s an ECO in another tenant", async () => {
    state.fake.tables.ecos[0].tenantId = "tenant-OTHER";
    expect((await GET(req("GET"), params)).status).toBe(404);
  });

  it("removes an item from a draft, and only from this ECO", async () => {
    const res = await DELETE(req("DELETE", { itemId: "item-1" }), params);
    expect(res.status).toBe(200);
    await DELETE(req("DELETE", { itemId: "other-eco-item" }), params);
    expect(items().map((i) => i.id)).toEqual(["other-eco-item"]);
  });

  it("does not remove items once the ECO is submitted", async () => {
    state.fake.tables.ecos[0].status = "SUBMITTED";
    const res = await DELETE(req("DELETE", { itemId: "item-1" }), params);
    expect(res.status).toBe(400);
    expect(items()).toHaveLength(2);
  });
});
