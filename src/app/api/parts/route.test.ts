import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * POST /api/parts — creating a part.
 */

const { tables, inserts, mockFrom } = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const tables: Record<string, Row[]> = {};
  const inserts: Array<{ table: string; data: Row }> = [];

  function makeChain(table: string) {
    const preds: Array<(r: Row) => boolean> = [];
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    let order: { col: string; ascending: boolean } | null = null;
    let limit: number | null = null;
    let range: [number, number] | null = null;
    const rows = () => {
      let out = (tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
      if (order) {
        const { col, ascending } = order;
        out = [...out].sort(
          (a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (ascending ? 1 : -1)
        );
      }
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limit !== null) out = out.slice(0, limit);
      return out;
    };
    chain.select = () => chain;
    chain.eq = (col, v) => (preds.push((r) => r[col as string] === v), chain);
    chain.is = (col, v) => (preds.push((r) => (r[col as string] ?? null) === v), chain);
    // PostgREST's `match` is a Postgres regex; the patterns used are plain
    // enough that a JS RegExp reads them the same way.
    chain.filter = (col, op, pattern) => {
      if (op !== "match") throw new Error(`unsupported operator ${String(op)}`);
      const re = new RegExp(pattern as string);
      preds.push((r) => re.test(String(r[col as string])));
      return chain;
    };
    chain.order = (col, opts) => (
      (order = {
        col: col as string,
        ascending: (opts as { ascending?: boolean } | undefined)?.ascending ?? true,
      }),
      chain
    );
    chain.limit = (n) => ((limit = n as number), chain);
    chain.range = (from, to) => ((range = [from as number, to as number]), chain);
    chain.single = () => ({ data: rows()[0] ?? null, error: null });
    chain.maybeSingle = () => ({ data: rows()[0] ?? null, error: null });
    chain.then = ((resolve: (v: unknown) => void) =>
      resolve({ data: rows(), error: null })) as never;
    // An update reports the rows it matched, which is what the part-number
    // counter's compare-and-swap reads to know whether it won.
    chain.update = (values) => {
      const u: Record<string, (...args: unknown[]) => unknown> = {};
      u.eq = (col, v) => (preds.push((r) => r[col as string] === v), u);
      u.select = () => ({
        then: (resolve: (v: unknown) => void) => {
          const matched = (tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
          for (const r of matched) Object.assign(r, values as Row);
          resolve({ data: matched, error: null });
        },
      });
      return u;
    };
    chain.insert = (data) => {
      const row = data as Row;
      inserts.push({ table, data: row });
      // parts_tenantId_partNumber_key
      const taken =
        table === "parts" &&
        (tables.parts ?? []).some(
          (p) => p.tenantId === row.tenantId && p.partNumber === row.partNumber
        );
      if (!taken && table === "parts") (tables.parts ??= []).push(row);
      const result = taken
        ? { data: null, error: { code: "23505", message: "duplicate key value" } }
        : { data: row, error: null };
      const c: Record<string, (...args: unknown[]) => unknown> = {};
      c.select = () => c;
      c.single = () => result;
      return c;
    };
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
  PERMISSIONS: { FILE_EDIT: "file.edit" },
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import { POST } from "./route";

const engineer = { id: "user-1", tenantId: "tenant-1", role: { permissions: ["file.edit"] } };

function create(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/parts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

function tenant(settings: Record<string, unknown>, partNumberSequence = 0) {
  tables.tenants = [{ id: "tenant-1", settings, partNumberSequence }];
}

/** Parts that arrived without the counter: an imported item master, say. */
function existingParts(...numbers: string[]) {
  tables.parts = numbers.map((partNumber, i) => ({
    id: `existing-${i}`,
    tenantId: "tenant-1",
    partNumber,
    deletedAt: null,
  }));
}

const counter = () => tables.tenants[0].partNumberSequence;

const partInserts = () => inserts.filter((i) => i.table === "parts");

beforeEach(() => {
  vi.clearAllMocks();
  inserts.length = 0;
  for (const k of Object.keys(tables)) delete tables[k];
  mockTenantUser.current = engineer;
});

/**
 * AUTO numbering hands out `tenants.partNumberSequence`, which only this route
 * advances. Imported parts and numbers typed by hand did not move it, so after
 * an item master import every create collided, retried one slot at a time,
 * burned ten numbers and answered 409.
 */
describe("POST /api/parts — automatic numbering", () => {
  const auto = { partNumberMode: "AUTO", partNumberPrefix: "PRT-", partNumberPadding: 5 };

  it("finds the next free number past an imported range in one create", async () => {
    tenant(auto, 0);
    existingParts(...Array.from({ length: 30 }, (_, i) => formatPrt(i + 1)));
    const res = await create({ name: "Bracket" });
    expect(res.status).toBe(200);
    expect((await res.json()).partNumber).toBe("PRT-00031");
    expect(counter()).toBe(31);
    // One collision, then straight past the range — not a slot at a time.
    expect(partInserts()).toHaveLength(2);
  });

  it("counts a part in the trash, which still owns its number", async () => {
    tenant(auto, 0);
    existingParts("PRT-00001", "PRT-00002");
    tables.parts[1].deletedAt = "2026-09-01T00:00:00Z";
    expect((await (await create({ name: "Bracket" })).json()).partNumber).toBe("PRT-00003");
  });

  it("jumps past a number that outgrew the padding", async () => {
    tenant(auto, 0);
    existingParts("PRT-00001", "PRT-99999", "PRT-100000");
    expect((await (await create({ name: "Bracket" })).json()).partNumber).toBe("PRT-100001");
  });

  it("is not thrown by numbers in some other format", async () => {
    tenant(auto, 0);
    existingParts("PRT-00001", "N1S-00500", "PRT-7", "PRT-00900-A");
    expect((await (await create({ name: "Bracket" })).json()).partNumber).toBe("PRT-00002");
  });

  it("moves the counter past a number typed by hand, so the next automatic one is free", async () => {
    tenant(auto, 4);
    expect((await create({ partNumber: "PRT-00500", name: "Typed" })).status).toBe(200);
    expect(counter()).toBe(500);

    inserts.length = 0;
    const res = await create({ name: "Automatic" });
    expect((await res.json()).partNumber).toBe("PRT-00501");
    expect(partInserts()).toHaveLength(1);
  });

  it("leaves the counter alone for a typed number the format could never mint", async () => {
    tenant(auto, 4);
    await create({ partNumber: "N1S-002", name: "Typed" });
    expect(counter()).toBe(4);
  });

  it("still refuses a typed number that is taken", async () => {
    tenant(auto, 0);
    existingParts("PRT-00001");
    expect((await create({ partNumber: "PRT-00001", name: "Dup" })).status).toBe(409);
  });
});

function formatPrt(n: number) {
  return `PRT-${String(n).padStart(5, "0")}`;
}

describe("POST /api/parts — lifecycle state", () => {
  beforeEach(() => tenant({ partNumberMode: "MANUAL" }));

  it("refuses creating a part that is already Released", async () => {
    // Released is what implementing an ECO means (AUD-003 CHG-4).
    const res = await create({ partNumber: "PN-1", name: "Idler", lifecycleState: "Released" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/A new part starts at WIP/);
    expect(partInserts()).toHaveLength(0);
  });

  it("creates in WIP, whatever the revision it starts from", async () => {
    const res = await create({ partNumber: "PN-1", name: "Idler", revision: "R2" });
    expect(res.status).toBe(200);
    expect(partInserts()[0].data).toMatchObject({ lifecycleState: "WIP", revision: "R2" });
  });
});

describe("POST /api/parts — locked unit cost", () => {
  it("refuses a new part that arrives with a unit cost", async () => {
    tenant({ costSource: "LOCKED" });
    const res = await create({ partNumber: "PN-1", name: "Bracket", unitCost: 4 });
    expect(res.status).toBe(403);
    expect(partInserts()).toHaveLength(0);
  });

  it("creates a part with no unit cost, and with an estimate", async () => {
    tenant({ costSource: "LOCKED" });
    const res = await create({
      partNumber: "PN-1",
      name: "Bracket",
      unitCost: null,
      estimatedCost: 3.5,
    });
    expect(res.status).toBe(200);
    expect(partInserts()[0].data).toMatchObject({ unitCost: null, estimatedCost: 3.5 });
  });

  it("creates a part with a unit cost when the tenant owns cost", async () => {
    tenant({ costSource: "OPEN" });
    const res = await create({ partNumber: "PN-1", name: "Bracket", unitCost: 4 });
    expect(res.status).toBe(200);
    expect(partInserts()[0].data).toMatchObject({ unitCost: 4 });
  });
});
