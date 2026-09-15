import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Two rules about what may be written to a BOM's lines.
 *
 * 1. A BOM an in-flight ECO carries is locked. `implement_eco` releases
 *    whatever the BOM holds when the ECO is implemented, so a line edited
 *    after approval would ship without review.
 * 2. A line may only point at a part or file in the caller's tenant. The
 *    lookup was tenant-filtered, but the id the client sent was saved whether
 *    or not the lookup found anything — so GET then served another tenant's
 *    part number, cost and thumbnail.
 */

const { tables, writes, inFilters, mockFrom } = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const tables: Record<string, Row[]> = {};
  const writes: Array<{ table: string; op: "insert" | "update" | "delete"; data?: unknown }> = [];
  /** Every `.in()` filter applied, so a test can see how many values went in one URL. */
  const inFilters: Array<{ table: string; column: string; size: number }> = [];

  function makeChain(table: string) {
    const preds: Array<(r: Row) => boolean> = [];
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    let range: [number, number] | null = null;
    const rows = () => {
      const matched = (tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
      // PostgREST's max-rows: no read returns more than 1,000, however it asks.
      return (range ? matched.slice(range[0], range[1] + 1) : matched).slice(0, 1000);
    };

    for (const m of ["select", "order", "limit"] as const) chain[m] = () => chain;
    chain.eq = (col, v) => (preds.push((r) => r[col as string] === v), chain);
    chain.is = (col, v) => (preds.push((r) => (r[col as string] ?? null) === v), chain);
    chain.in = (col, vs) => {
      inFilters.push({ table, column: col as string, size: (vs as unknown[]).length });
      preds.push((r) => (vs as unknown[]).includes(r[col as string]));
      return chain;
    };
    chain.range = (from, to) => ((range = [from as number, to as number]), chain);
    chain.single = () => ({ data: rows()[0] ?? null, error: null });
    chain.maybeSingle = () => ({ data: rows()[0] ?? null, error: null });
    chain.then = ((resolve: (v: unknown) => void) =>
      resolve({ data: rows(), error: null })) as never;

    chain.insert = (data) => {
      writes.push({ table, op: "insert", data });
      const c: Record<string, (...args: unknown[]) => unknown> = {};
      c.select = () => c;
      c.single = () => ({ data, error: null });
      c.then = ((resolve: (v: unknown) => void) => resolve({ data, error: null })) as never;
      return c;
    };
    chain.update = (data) => {
      writes.push({ table, op: "update", data });
      const c: Record<string, (...args: unknown[]) => unknown> = {};
      c.eq = () => c;
      c.select = () => c;
      c.single = () => ({ data: { ...(data as Row), name: "Line", itemNumber: "1" }, error: null });
      return c;
    };
    chain.delete = () => {
      writes.push({ table, op: "delete" });
      const c: Record<string, (...args: unknown[]) => unknown> = {};
      c.eq = () => c;
      c.then = ((resolve: (v: unknown) => void) => resolve({ error: null })) as never;
      return c;
    };
    return chain;
  }

  return { tables, writes, inFilters, mockFrom: (t: string) => makeChain(t) };
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

import { POST, PUT, DELETE } from "./route";

const BOM_ID = "11111111-1111-4111-8111-111111111111";
const ECO_ID = "22222222-2222-4222-8222-222222222222";
const OWN_PART = "33333333-3333-4333-8333-333333333333";
const FOREIGN_PART = "44444444-4444-4444-8444-444444444444";
const OWN_FILE = "55555555-5555-4555-8555-555555555555";
const FOREIGN_FILE = "66666666-6666-4666-8666-666666666666";
const ITEM_ID = "77777777-7777-4777-8777-777777777777";

const engineer = { id: "user-1", tenantId: "tenant-1", role: { permissions: ["file.edit"] } };

function req(method: string, body: unknown) {
  return new NextRequest(`http://localhost/api/boms/${BOM_ID}/items`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const params = Promise.resolve({ bomId: BOM_ID });

function state({
  bomStatus = "DRAFT",
  ecoStatus = null as string | null,
  ecoTenant = "tenant-1",
} = {}) {
  tables["boms"] = [
    {
      id: BOM_ID,
      tenantId: "tenant-1",
      status: bomStatus,
      fileId: null,
      file: null,
      deletedAt: null,
    },
  ];
  tables["bom_items"] = [{ id: ITEM_ID, bomId: BOM_ID, name: "Line", itemNumber: "1" }];
  tables["eco_items"] = ecoStatus ? [{ ecoId: ECO_ID, bomId: BOM_ID }] : [];
  tables["ecos"] = ecoStatus
    ? [
        {
          id: ECO_ID,
          tenantId: ecoTenant,
          ecoNumber: "ECO-0042",
          status: ecoStatus,
          deletedAt: null,
        },
      ]
    : [];
  tables["parts"] = [
    {
      id: OWN_PART,
      tenantId: "tenant-1",
      partNumber: "P-1",
      name: "Bracket",
      unitCost: 2,
      deletedAt: null,
    },
    {
      id: FOREIGN_PART,
      tenantId: "tenant-OTHER",
      partNumber: "SECRET-9",
      name: "Their part",
      unitCost: 99,
      deletedAt: null,
    },
  ];
  tables["part_vendors"] = [];
  tables["files"] = [
    { id: OWN_FILE, tenantId: "tenant-1", deletedAt: null },
    { id: FOREIGN_FILE, tenantId: "tenant-OTHER", deletedAt: null },
  ];
}

const bomItemWrites = () => writes.filter((w) => w.table === "bom_items");

beforeEach(() => {
  vi.clearAllMocks();
  mockTenantUser.current = engineer;
  writes.length = 0;
  inFilters.length = 0;
  for (const k of Object.keys(tables)) delete tables[k];
});

describe("BOM lines are locked while an ECO carrying the BOM is in flight", () => {
  it.each(["SUBMITTED", "IN_REVIEW", "APPROVED"])(
    "refuses to add a line when the ECO is %s, naming the ECO",
    async (ecoStatus) => {
      state({ ecoStatus });
      const res = await POST(req("POST", { name: "Late addition" }), { params });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toContain("ECO-0042");
      expect(bomItemWrites()).toHaveLength(0);
    }
  );

  it("refuses to edit a line on an approved ECO's BOM — the reported bug", async () => {
    state({ ecoStatus: "APPROVED" });
    const res = await PUT(req("PUT", { itemId: ITEM_ID, quantity: 12 }), { params });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("ECO-0042");
    expect(bomItemWrites()).toHaveLength(0);
  });

  it("refuses to delete a line", async () => {
    state({ ecoStatus: "IN_REVIEW" });
    const res = await DELETE(req("DELETE", { itemId: ITEM_ID }), { params });
    expect(res.status).toBe(409);
    expect(bomItemWrites()).toHaveLength(0);
  });

  it.each(["DRAFT", "REJECTED"])("allows edits while the ECO is %s", async (ecoStatus) => {
    state({ ecoStatus });
    const res = await PUT(req("PUT", { itemId: ITEM_ID, quantity: 12 }), { params });
    expect(res.status).toBe(200);
    expect(bomItemWrites()).toHaveLength(1);
  });

  it("is not locked by another tenant's ECO", async () => {
    state({ ecoStatus: "APPROVED", ecoTenant: "tenant-OTHER" });
    const res = await PUT(req("PUT", { itemId: ITEM_ID, quantity: 12 }), { params });
    expect(res.status).toBe(200);
  });

  it("still refuses a RELEASED BOM with the 400 it always returned", async () => {
    state({ bomStatus: "RELEASED" });
    const res = await PUT(req("PUT", { itemId: ITEM_ID, quantity: 12 }), { params });
    expect(res.status).toBe(400);
    expect(bomItemWrites()).toHaveLength(0);
  });
});

describe("BOM lines may only reference the caller's own parts and files", () => {
  it("links a line to a part in the caller's tenant", async () => {
    state();
    const res = await POST(req("POST", { partId: OWN_PART }), { params });
    expect(res.status).toBe(200);
    expect(bomItemWrites()[0].data).toMatchObject({ partId: OWN_PART, partNumber: "P-1" });
  });

  it("refuses another tenant's part on create", async () => {
    state();
    const res = await POST(req("POST", { partId: FOREIGN_PART, name: "x" }), { params });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/part not found/i);
    expect(bomItemWrites()).toHaveLength(0);
  });

  it("refuses another tenant's file on create", async () => {
    state();
    const res = await POST(req("POST", { fileId: FOREIGN_FILE, name: "x" }), { params });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/file not found/i);
    expect(bomItemWrites()).toHaveLength(0);
  });

  it("refuses a soft-deleted part", async () => {
    state();
    tables["parts"][0].deletedAt = "2026-09-01T00:00:00Z";
    const res = await POST(req("POST", { partId: OWN_PART }), { params });
    expect(res.status).toBe(404);
  });

  it("refuses another tenant's part on update", async () => {
    state();
    const res = await PUT(req("PUT", { itemId: ITEM_ID, partId: FOREIGN_PART }), { params });
    expect(res.status).toBe(404);
    expect(bomItemWrites()).toHaveLength(0);
  });

  it("refuses another tenant's file on update", async () => {
    state();
    const res = await PUT(req("PUT", { itemId: ITEM_ID, fileId: FOREIGN_FILE }), { params });
    expect(res.status).toBe(404);
    expect(bomItemWrites()).toHaveLength(0);
  });

  it("accepts the caller's own file on update, and clearing a part", async () => {
    state();
    const res = await PUT(req("PUT", { itemId: ITEM_ID, fileId: OWN_FILE, partId: null }), {
      params,
    });
    expect(res.status).toBe(200);
    expect(bomItemWrites()[0].data).toMatchObject({ fileId: OWN_FILE, partId: null });
  });
});

/**
 * CSV import into an existing BOM had never worked.
 *
 * The POST schema was a union with the single-item shape first. Every field of
 * that shape is optional and unknown keys are stripped, so `{ items: [...] }`
 * parsed as one empty item: the route inserted a single blank line and
 * answered with that row, and the client toasted "Imported undefined items".
 * And even had the lines landed, they carried part numbers and no `partId`, so
 * a BOM built from a CSV could never be sent for review.
 */
describe("bulk POST — importing lines into an existing BOM", () => {
  const insertedRows = () =>
    bomItemWrites()
      .filter((w) => w.op === "insert")
      .flatMap((w) => (Array.isArray(w.data) ? w.data : [w.data])) as Array<
      Record<string, unknown>
    >;

  it("inserts every line and reports the count — not one blank line", async () => {
    state();
    const res = await POST(
      req("POST", {
        items: [
          { itemNumber: "001", name: "Frame", quantity: 2 },
          { itemNumber: "002", name: "Cover", quantity: 0 },
        ],
      }),
      { params }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.inserted).toBe(2);
    expect(insertedRows()).toHaveLength(2);
    expect(insertedRows().map((r) => r.name)).toEqual(["Frame", "Cover"]);
    // A quantity of 0 is a value, not a blank to default.
    expect(insertedRows()[1].quantity).toBe(0);
  });

  it("refuses a malformed batch outright instead of reading it as a single item", async () => {
    state();
    const res = await POST(req("POST", { items: [{ name: "Frame", quantity: -1 }] }), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).details).toHaveProperty(["items.0.quantity"]);
    expect(bomItemWrites()).toHaveLength(0);
  });

  it("refuses an items value that is not a list", async () => {
    state();
    const res = await POST(req("POST", { items: "Frame" }), { params });
    expect(res.status).toBe(400);
    expect(bomItemWrites()).toHaveLength(0);
  });

  it("links lines to the caller's parts by part number, and says which did not match", async () => {
    state();
    const res = await POST(
      req("POST", {
        items: [
          { name: "", partNumber: "P-1", quantity: 1 },
          { name: "Mystery", partNumber: "NOPE-7", quantity: 1 },
        ],
      }),
      { params }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.linked).toBe(1);
    expect(body.unmatchedPartNumbers).toEqual(["NOPE-7"]);
    const [matched, unmatched] = insertedRows();
    // Linked, and the blank name filled from the part.
    expect(matched).toMatchObject({ partId: OWN_PART, partNumber: "P-1", name: "Bracket" });
    expect(unmatched).toMatchObject({ partId: null, partNumber: "NOPE-7", name: "Mystery" });
  });

  it("never links to another tenant's part that happens to share the number", async () => {
    state();
    const res = await POST(
      req("POST", { items: [{ name: "Copy", partNumber: "SECRET-9", quantity: 1 }] }),
      { params }
    );
    expect(res.status).toBe(200);
    expect((await res.json()).unmatchedPartNumbers).toEqual(["SECRET-9"]);
    expect(insertedRows()[0]).toMatchObject({ partId: null });
  });

  it("does not link to a part in the trash", async () => {
    state();
    tables["parts"][0].deletedAt = "2026-09-01T00:00:00Z";
    const res = await POST(
      req("POST", { items: [{ name: "Old", partNumber: "P-1", quantity: 1 }] }),
      { params }
    );
    expect(res.status).toBe(200);
    expect(insertedRows()[0]).toMatchObject({ partId: null });
  });

  it("falls back to the part number for a line with no name that matched nothing", async () => {
    state();
    await POST(req("POST", { items: [{ name: "", partNumber: "NOPE-7", quantity: 1 }] }), {
      params,
    });
    expect(insertedRows()[0]).toMatchObject({ name: "NOPE-7" });
  });

  it("keeps an explicit partId rather than re-matching by number", async () => {
    state();
    tables["parts"].push({
      id: "88888888-8888-4888-8888-888888888888",
      tenantId: "tenant-1",
      partNumber: "P-2",
      name: "Other",
      deletedAt: null,
    });
    await POST(req("POST", { items: [{ partId: OWN_PART, partNumber: "P-2", quantity: 1 }] }), {
      params,
    });
    expect(insertedRows()[0]).toMatchObject({ partId: OWN_PART });
  });

  it("looks part numbers up in URL-sized chunks, and still links every line", async () => {
    state();
    const count = 450;
    for (let i = 0; i < count; i++) {
      tables["parts"].push({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        tenantId: "tenant-1",
        partNumber: `BULK-${i}`,
        name: `Bulk ${i}`,
        deletedAt: null,
      });
    }
    const res = await POST(
      req("POST", {
        items: Array.from({ length: count }, (_, i) => ({
          name: "",
          partNumber: `BULK-${i}`,
          quantity: 1,
        })),
      }),
      { params }
    );
    expect(res.status).toBe(200);
    expect((await res.json()).linked).toBe(count);
    const lookups = inFilters.filter((f) => f.table === "parts" || f.table === "part_vendors");
    expect(Math.max(...lookups.map((f) => f.size))).toBeLessThanOrEqual(100);
  });

  it("is still refused while an in-flight ECO carries the BOM", async () => {
    state({ ecoStatus: "APPROVED" });
    const res = await POST(req("POST", { items: [{ name: "Late", quantity: 1 }] }), { params });
    expect(res.status).toBe(409);
    expect(bomItemWrites()).toHaveLength(0);
  });

  it("is still refused on a released BOM", async () => {
    state({ bomStatus: "RELEASED" });
    const res = await POST(req("POST", { items: [{ name: "Late", quantity: 1 }] }), { params });
    expect(res.status).toBe(400);
    expect(bomItemWrites()).toHaveLength(0);
  });

  it("404s another tenant's BOM", async () => {
    state();
    tables["boms"][0].tenantId = "tenant-OTHER";
    const res = await POST(req("POST", { items: [{ name: "x", quantity: 1 }] }), { params });
    expect(res.status).toBe(404);
    expect(bomItemWrites()).toHaveLength(0);
  });

  it("still adds a single line when the body has no items key", async () => {
    state();
    const res = await POST(req("POST", { name: "Single", quantity: 3 }), { params });
    expect(res.status).toBe(200);
    expect(insertedRows()).toHaveLength(1);
    expect(insertedRows()[0]).toMatchObject({ name: "Single", quantity: 3 });
  });
});
