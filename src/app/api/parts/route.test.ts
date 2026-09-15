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
    const rows = () => (tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
    for (const m of ["select", "order", "limit"] as const) chain[m] = () => chain;
    chain.eq = (col, v) => (preds.push((r) => r[col as string] === v), chain);
    chain.is = (col, v) => (preds.push((r) => (r[col as string] ?? null) === v), chain);
    chain.single = () => ({ data: rows()[0] ?? null, error: null });
    chain.maybeSingle = () => ({ data: rows()[0] ?? null, error: null });
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

function tenant(settings: Record<string, unknown>) {
  tables.tenants = [{ id: "tenant-1", settings }];
}

const partInserts = () => inserts.filter((i) => i.table === "parts");

beforeEach(() => {
  vi.clearAllMocks();
  inserts.length = 0;
  for (const k of Object.keys(tables)) delete tables[k];
  mockTenantUser.current = engineer;
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
