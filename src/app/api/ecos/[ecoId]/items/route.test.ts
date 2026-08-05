import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * `eco_items` can point at a part, a file, or — since migration 046 — a BOM.
 * Exactly one, enforced by a CHECK in the database and a `.refine()` on the
 * schema. These cover the BOM path and the exclusivity rule, because an ECO
 * item pointing at two things has no defined meaning on implement.
 */

const { tables, inserts, mockFrom } = vi.hoisted(() => {
  const tables: Record<string, Record<string, unknown>[]> = {};
  const inserts: Record<string, Record<string, unknown>[]> = {};

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
      const row = data as Record<string, unknown>;
      inserts[table] = (inserts[table] ?? []).concat(row);
      const done = { data: row, error: null };
      const c: Record<string, (...args: unknown[]) => unknown> = {};
      c.select = () => c;
      c.single = () => done;
      c.then = ((r: (v: unknown) => void) => r(done)) as never;
      return c;
    };
    chain.then = ((r: (v: unknown) => void) => r({ data: rows(), error: null })) as never;
    return chain;
  }

  return { tables, inserts, mockFrom: (t: string) => makeChain(t) };
});

const mockTenantUser = vi.hoisted(() => ({
  current: null as { id: string; tenantId: string; role: { permissions: string[] } } | null,
}));

vi.mock("@/lib/db", () => ({ getServiceClient: () => ({ from: mockFrom }) }));
vi.mock("@/lib/auth", () => ({
  getApiTenantUser: () => Promise.resolve(mockTenantUser.current),
  hasPermission: (perms: string[], p: string) => perms.includes("*") || perms.includes(p),
  PERMISSIONS: { ECO_EDIT: "eco.edit" },
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import { POST } from "./route";

const ECO_ID = "11111111-1111-4111-8111-111111111111";
const BOM_ID = "22222222-2222-4222-8222-222222222222";

const engineer = { id: "user-1", tenantId: "tenant-1", role: { permissions: ["*"] } };

function req(body: unknown) {
  return new NextRequest(`http://localhost/api/ecos/${ECO_ID}/items`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const params = Promise.resolve({ ecoId: ECO_ID });

function state(bomTenant = "tenant-1") {
  tables["ecos"] = [
    { id: ECO_ID, tenantId: "tenant-1", status: "DRAFT", ecoNumber: "ECO-1", deletedAt: null },
  ];
  tables["boms"] = [
    {
      id: BOM_ID,
      tenantId: bomTenant,
      name: "NANO-1000S",
      revision: "B",
      status: "RELEASED",
      deletedAt: null,
    },
  ];
  tables["eco_items"] = [];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTenantUser.current = engineer;
  for (const k of Object.keys(tables)) delete tables[k];
  for (const k of Object.keys(inserts)) delete inserts[k];
});

describe("POST /api/ecos/[ecoId]/items — BOM items", () => {
  it("adds a BOM to the ECO and seeds fromRevision from the BOM", async () => {
    state();
    const res = await POST(req({ bomId: BOM_ID, changeType: "MODIFY" }), { params });
    expect(res.status).toBe(200);

    const item = inserts["eco_items"][0];
    expect(item).toMatchObject({
      ecoId: ECO_ID,
      bomId: BOM_ID,
      partId: null,
      fileId: null,
      // Records what the structure looked like before the change.
      fromRevision: "B",
    });
  });

  it("carries an explicit toRevision through", async () => {
    state();
    await POST(req({ bomId: BOM_ID, changeType: "MODIFY", toRevision: "C" }), { params });
    expect(inserts["eco_items"][0].toRevision).toBe("C");
  });

  it("returns 404 for a BOM in another tenant", async () => {
    state("tenant-OTHER");
    const res = await POST(req({ bomId: BOM_ID, changeType: "MODIFY" }), { params });
    expect(res.status).toBe(404);
    expect(inserts["eco_items"]).toBeUndefined();
  });

  it("refuses the same BOM twice on one ECO", async () => {
    state();
    tables["eco_items"] = [{ id: "existing", ecoId: ECO_ID, bomId: BOM_ID }];
    const res = await POST(req({ bomId: BOM_ID, changeType: "MODIFY" }), { params });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already in this eco/i);
  });

  it("requires exactly one target", async () => {
    state();
    // Two targets has no defined meaning on implement.
    const both = await POST(req({ bomId: BOM_ID, partId: "p-1", changeType: "MODIFY" }), {
      params,
    });
    expect(both.status).toBe(400);

    const none = await POST(req({ changeType: "MODIFY" }), { params });
    expect(none.status).toBe(400);

    expect(inserts["eco_items"]).toBeUndefined();
  });
});
