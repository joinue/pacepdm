import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Revising creates a new BOM and copies a structure, so the refusals are
 * what keep it safe: only a released BOM, only one open revision at a time,
 * never a superseded one, and never a guessed revision.
 *
 * The invariant worth naming: the SOURCE must come out untouched. A revision
 * that mutated revision A would break every released document citing it.
 */

const { tables, inserts, updates, mockFrom } = vi.hoisted(() => {
  const tables: Record<string, Record<string, unknown>[]> = {};
  const inserts: Record<string, Record<string, unknown>[]> = {};
  const updates: Array<{ table: string; data: unknown }> = [];

  function makeChain(table: string) {
    const filters: Record<string, unknown> = {};
    const chain: Record<string, (...args: unknown[]) => unknown> = {};

    const rows = () => {
      let out = tables[table] ?? [];
      for (const [k, v] of Object.entries(filters)) out = out.filter((r) => r[k] === v);
      return out;
    };

    for (const m of ["select", "is", "not", "order", "limit", "in"] as const)
      chain[m] = () => chain;
    chain.eq = (...a: unknown[]) => {
      filters[a[0] as string] = a[1];
      return chain;
    };
    chain.maybeSingle = () => ({ data: rows()[0] ?? null, error: null });
    chain.single = () => ({ data: rows()[0] ?? null, error: null });
    chain.insert = (data: unknown) => {
      const list = (Array.isArray(data) ? data : [data]) as Record<string, unknown>[];
      const err = insertError.current;
      if (!err) inserts[table] = (inserts[table] ?? []).concat(list);
      const done = { data: null, error: err };
      const c: Record<string, (...args: unknown[]) => unknown> = {};
      c.select = () => c;
      c.single = () => done;
      c.then = ((r: (v: unknown) => void) => r(done)) as never;
      return c;
    };
    chain.update = (data: unknown) => {
      updates.push({ table, data });
      const c: Record<string, (...args: unknown[]) => unknown> = {};
      c.eq = () => c;
      c.then = ((r: (v: unknown) => void) => r({ data: null, error: null })) as never;
      return c;
    };
    chain.then = ((r: (v: unknown) => void) => r({ data: rows(), error: null })) as never;
    return chain;
  }

  const insertError: { current: { code?: string; message: string } | null } = { current: null };
  return { tables, inserts, updates, insertError, mockFrom: (t: string) => makeChain(t) };
});

const mockTenantUser = vi.hoisted(() => ({
  current: null as { id: string; tenantId: string; role: { permissions: string[] } } | null,
}));

vi.mock("@/lib/db", () => ({ getServiceClient: () => ({ from: mockFrom }) }));
vi.mock("@/lib/auth", () => ({
  getApiTenantUser: () => Promise.resolve(mockTenantUser.current),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import { POST } from "./route";
import { logAudit } from "@/lib/audit";

const BOM_A = "11111111-1111-4111-8111-111111111111";
const engineer = { id: "user-1", tenantId: "tenant-1", role: { permissions: ["file.edit"] } };
const viewer = { id: "user-2", tenantId: "tenant-1", role: { permissions: ["file.view"] } };

function req(body: unknown = {}) {
  return new NextRequest(`http://localhost/api/boms/${BOM_A}/revise`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const params = Promise.resolve({ bomId: BOM_A });

function state(bomOverrides: Record<string, unknown> = {}, itemCount = 2, tenantId = "tenant-1") {
  tables["boms"] = [
    {
      id: BOM_A,
      tenantId,
      name: "NANO-1000S",
      revision: "A",
      status: "RELEASED",
      fileId: null,
      partId: "part-1",
      previousRevisionId: null,
      supersededById: null,
      deletedAt: null,
      ...bomOverrides,
    },
  ];
  tables["bom_items"] = Array.from({ length: itemCount }, (_, i) => ({
    id: `item-${i}`,
    bomId: BOM_A,
    itemNumber: String(i + 1),
    sortOrder: i + 1,
    partNumber: `P-${i}`,
    quantity: i + 1,
    unit: "EA",
    linkedBomId: null,
    optionGroup: i === 0 ? "Voltage" : null,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTenantUser.current = engineer;
  updates.length = 0;
  for (const k of Object.keys(tables)) delete tables[k];
  for (const k of Object.keys(inserts)) delete inserts[k];
});

describe("POST /api/boms/[bomId]/revise", () => {
  it("returns 401 when not authenticated", async () => {
    mockTenantUser.current = null;
    state();
    expect((await POST(req(), { params })).status).toBe(401);
  });

  it("returns 403 without FILE_EDIT", async () => {
    mockTenantUser.current = viewer;
    state();
    expect((await POST(req(), { params })).status).toBe(403);
  });

  it("returns 404 for a BOM in another tenant", async () => {
    state({}, 2, "tenant-OTHER");
    expect((await POST(req(), { params })).status).toBe(404);
  });

  it("creates the next revision as a DRAFT copy, leaving the source untouched", async () => {
    state();
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);

    const created = inserts["boms"][0];
    expect(created).toMatchObject({
      name: "NANO-1000S",
      revision: "B",
      status: "DRAFT",
      previousRevisionId: BOM_A,
      partId: "part-1",
    });

    // The whole point: revision A is not modified by revising it.
    expect(updates).toHaveLength(0);
  });

  it("copies every item onto the new revision with fresh ids", async () => {
    state();
    const body = await (await POST(req(), { params })).json();
    expect(body.itemsCopied).toBe(2);

    const copies = inserts["bom_items"];
    expect(copies).toHaveLength(2);
    const newBomId = inserts["boms"][0].id;
    for (const copy of copies) {
      expect(copy.bomId).toBe(newBomId);
      expect(copy.id).not.toMatch(/^item-/);
    }
    // Structure carries over, options included.
    expect(copies[0].optionGroup).toBe("Voltage");
    expect(copies.map((c) => c.quantity)).toEqual([1, 2]);
  });

  it("copies a BOM with no items without failing", async () => {
    state({}, 0);
    const body = await (await POST(req(), { params })).json();
    expect(body.itemsCopied).toBe(0);
    expect(inserts["bom_items"]).toBeUndefined();
  });

  it("refuses to revise a DRAFT — edit it in place instead", async () => {
    state({ status: "DRAFT" });
    const res = await POST(req(), { params });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/only a released bom/i);
    expect(inserts["boms"]).toBeUndefined();
  });

  it("refuses to revise a superseded revision", async () => {
    state({ supersededById: "some-newer-bom" });
    const res = await POST(req(), { params });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already been superseded/i);
  });

  it("refuses a second open revision from the same source", async () => {
    state();
    tables["boms"].push({
      id: "bom-b",
      tenantId: "tenant-1",
      name: "NANO-1000S",
      revision: "B",
      status: "DRAFT",
      previousRevisionId: BOM_A,
      deletedAt: null,
    });

    const res = await POST(req(), { params });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/revision B has already been started/i);
  });

  it("refuses rather than guessing when the revision cannot be sequenced", async () => {
    // "Z" is a reserved letter, so there is no defensible next value.
    state({ revision: "Z" });
    const res = await POST(req(), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cannot work out the revision/i);
    expect(inserts["boms"]).toBeUndefined();
  });

  it("accepts an explicit revision, including past an unsequenceable one", async () => {
    state({ revision: "Z" });
    const res = await POST(req({ revision: "AA" }), { params });
    expect(res.status).toBe(200);
    expect(inserts["boms"][0].revision).toBe("AA");
  });

  it("sequences PACE's own R<n> scheme", async () => {
    state({ revision: "R2" });
    await POST(req(), { params });
    expect(inserts["boms"][0].revision).toBe("R3");
  });

  it("links the new revision to an ECO when one is given", async () => {
    state();
    const ecoId = "22222222-2222-4222-8222-222222222222";
    await POST(req({ ecoId }), { params });

    expect(inserts["eco_items"]).toHaveLength(1);
    expect(inserts["eco_items"][0]).toMatchObject({
      ecoId,
      bomId: inserts["boms"][0].id,
      fromRevision: "A",
      toRevision: "B",
    });
  });

  it("logs the revision against the new BOM, recording where it came from", async () => {
    state();
    await POST(req(), { params });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "bom.revise",
        entityId: inserts["boms"][0].id,
        details: expect.objectContaining({ fromRevision: "A", toRevision: "B", itemsCopied: 2 }),
      })
    );
  });
});
