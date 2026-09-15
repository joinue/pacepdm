import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * PUT /api/parts/[partId] under a locked cost source.
 *
 * `unitCost` belongs to the connected cost system once a tenant locks it. The
 * route used to refuse any body that *named* `unitCost`, and the part form
 * sends every field it shows — so locking cost made every part in the tenant
 * uneditable, name and description included. The lock is on changing the
 * figure, and that is what these tests hold it to.
 */

const { tables, writes, mockFrom } = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const tables: Record<string, Row[]> = {};
  const writes: Array<{ table: string; op: "update"; data: Row }> = [];

  function makeChain(table: string) {
    const preds: Array<(r: Row) => boolean> = [];
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    const rows = () => (tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
    for (const m of ["select", "order", "limit"] as const) chain[m] = () => chain;
    chain.eq = (col, v) => (preds.push((r) => r[col as string] === v), chain);
    chain.is = (col, v) => (preds.push((r) => (r[col as string] ?? null) === v), chain);
    chain.single = () => ({ data: rows()[0] ?? null, error: null });
    chain.maybeSingle = () => ({ data: rows()[0] ?? null, error: null });
    chain.update = (data) => {
      writes.push({ table, op: "update", data: data as Row });
      const c: Record<string, (...args: unknown[]) => unknown> = {};
      c.eq = () => c;
      c.select = () => c;
      c.single = () => ({ data: { ...rows()[0], ...(data as Row) }, error: null });
      return c;
    };
    return chain;
  }
  return { tables, writes, mockFrom: (t: string) => makeChain(t) };
});

const mockTenantUser = vi.hoisted(() => ({
  current: null as { id: string; tenantId: string; role: { permissions: string[] } } | null,
}));

vi.mock("@/lib/db", () => ({ getServiceClient: () => ({ from: mockFrom }) }));
vi.mock("@/lib/auth", () => ({
  getApiTenantUser: () => Promise.resolve(mockTenantUser.current),
  hasPermission: (perms: string[], p: string) => perms.includes("*") || perms.includes(p),
  PERMISSIONS: { FILE_EDIT: "file.edit" },
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import { PUT } from "./route";

const PART_ID = "33333333-3333-4333-8333-333333333333";
const engineer = { id: "user-1", tenantId: "tenant-1", role: { permissions: ["file.edit"] } };

function put(body: unknown) {
  return PUT(
    new NextRequest(`http://localhost/api/parts/${PART_ID}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ partId: PART_ID }) }
  );
}

function state({
  costSource = "LOCKED",
  unitCost = 4.25 as number | null,
  tenantId = "tenant-1",
} = {}) {
  tables["tenants"] = [{ id: "tenant-1", settings: { costSource } }];
  tables["parts"] = [
    { id: PART_ID, tenantId, partNumber: "PN-1042", name: "Idler", unitCost, deletedAt: null },
  ];
}

const partUpdates = () => writes.filter((w) => w.table === "parts");

beforeEach(() => {
  vi.clearAllMocks();
  writes.length = 0;
  for (const k of Object.keys(tables)) delete tables[k];
  mockTenantUser.current = engineer;
});

describe("PUT /api/parts/[partId] — locked unit cost", () => {
  it("saves an edit that sends the unchanged cost back — the reported bug", async () => {
    state();
    const res = await put({ name: "Idler, long", unitCost: 4.25, estimatedCost: 5 });
    expect(res.status).toBe(200);
    expect(partUpdates()).toHaveLength(1);
    expect(partUpdates()[0].data).toMatchObject({ name: "Idler, long", estimatedCost: 5 });
    // The unchanged figure is not rewritten.
    expect(partUpdates()[0].data).not.toHaveProperty("unitCost");
  });

  it("saves an edit that does not mention cost", async () => {
    state();
    expect((await put({ description: "Bent" })).status).toBe(200);
    expect(partUpdates()).toHaveLength(1);
  });

  it("refuses a different figure, and writes nothing", async () => {
    state();
    const res = await put({ name: "Idler", unitCost: 9.99 });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/estimated cost/i);
    expect(partUpdates()).toHaveLength(0);
  });

  it("refuses clearing a cost that is set", async () => {
    state();
    expect((await put({ unitCost: null })).status).toBe(403);
    expect(partUpdates()).toHaveLength(0);
  });

  it("refuses setting a cost on a part that has none", async () => {
    state({ unitCost: null });
    expect((await put({ unitCost: 1 })).status).toBe(403);
  });

  it("accepts null for a part that has no cost", async () => {
    state({ unitCost: null });
    expect((await put({ name: "Idler", unitCost: null })).status).toBe(200);
  });
});

describe("PUT /api/parts/[partId] — open unit cost", () => {
  it("writes a changed cost", async () => {
    state({ costSource: "OPEN" });
    const res = await put({ unitCost: 9.99 });
    expect(res.status).toBe(200);
    expect(partUpdates()[0].data).toMatchObject({ unitCost: 9.99 });
  });
});

describe("PUT /api/parts/[partId] — access", () => {
  it("401s without a session", async () => {
    state();
    mockTenantUser.current = null;
    expect((await put({ name: "x" })).status).toBe(401);
  });

  it("403s without file.edit", async () => {
    state();
    mockTenantUser.current = { ...engineer, role: { permissions: ["file.view"] } };
    expect((await put({ name: "x" })).status).toBe(403);
  });

  it("404s another tenant's part", async () => {
    state({ tenantId: "tenant-OTHER" });
    expect((await put({ name: "x" })).status).toBe(404);
    expect(partUpdates()).toHaveLength(0);
  });
});
