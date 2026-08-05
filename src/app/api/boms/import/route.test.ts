import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The parser is covered exhaustively in `src/lib/bom-import.test.ts`. What
 * matters here is persistence: that BOM rows are all written before any item
 * row (so `linkedBomId` resolves regardless of file order), that a duplicate
 * BOM name is skipped rather than duplicated, and that every line lands with
 * a real `partId` — the integration plan requires no free-text BOM lines.
 *
 * The mock records inserts per table so ordering between tables is
 * observable, which is the only way to test the "all BOMs first" invariant.
 */

const { inserts, updates, tableResults, mockFrom, insertOrder } = vi.hoisted(() => {
  const inserts: Record<string, Record<string, unknown>[]> = {};
  const updates: Array<{ table: string; data: Record<string, unknown> }> = [];
  const tableResults: Record<string, { data: unknown; error: unknown }> = {};
  const insertOrder: string[] = [];

  function makeChain(table: string) {
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    const resolvable = () => tableResults[table] ?? { data: [], error: null };

    for (const m of ["select", "eq", "in", "is", "not", "order", "limit"] as const) {
      chain[m] = () => chain;
    }

    chain.insert = (rows: unknown) => {
      const list = Array.isArray(rows) ? rows : [rows];
      inserts[table] = (inserts[table] ?? []).concat(list as Record<string, unknown>[]);
      for (let i = 0; i < list.length; i++) insertOrder.push(table);
      const done = { data: null, error: null };
      const c: Record<string, (...args: unknown[]) => unknown> = {};
      c.select = () => c;
      c.single = () => done;
      c.then = ((resolve: (v: unknown) => void) => resolve(done)) as never;
      return c;
    };

    chain.update = (data: unknown) => {
      updates.push({ table, data: data as Record<string, unknown> });
      const done = { data: null, error: null };
      const c: Record<string, (...args: unknown[]) => unknown> = {};
      c.eq = () => c;
      c.select = () => c;
      c.single = () => done;
      c.then = ((resolve: (v: unknown) => void) => resolve(done)) as never;
      return c;
    };

    chain.then = ((resolve: (v: unknown) => void) => resolve(resolvable())) as never;
    return chain;
  }

  return { inserts, updates, tableResults, insertOrder, mockFrom: (t: string) => makeChain(t) };
});

const mockTenantUser = vi.hoisted(() => ({
  current: null as {
    id: string;
    tenantId: string;
    fullName: string;
    role: { permissions: string[] };
  } | null,
}));

vi.mock("@/lib/db", () => ({ getServiceClient: () => ({ from: mockFrom }) }));
vi.mock("@/lib/auth", () => ({
  getApiTenantUser: () => Promise.resolve(mockTenantUser.current),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import { POST } from "./route";
import { logAudit } from "@/lib/audit";

const HEADER =
  "Flag,Description,Type,Part,Quantity,UOM,IsVariableQuantity,MinQuantity,MaxQuantity,OptionGroup,OptionGroupPrompt\n";

/**
 * A two-level build list where the parent references a sub-assembly defined
 * BELOW it — the shape that breaks a naive single-pass importer.
 */
const CSV =
  HEADER +
  "BOM,TOP-1,Top level machine,TRUE,1\n" +
  "Item,Create TOP-1,Finished Good,TOP-1,1,ea\n" +
  "Item,Add SUB-1,Raw Good,SUB-1,2,ea\n" +
  "Item,Add LEAF-1-R2,Raw Good,LEAF-1-R2,3,ea\n" +
  "Item,Add OPT-A,Raw Good,OPT-A,1,ea,FALSE,0,0,Voltage,What Voltage ordered\n" +
  ",,,,,,,,,,\n" +
  "BOM,SUB-1,Sub assembly,TRUE,1\n" +
  "Item,Create SUB-1,Finished Good,SUB-1,1,ea\n" +
  "Item,Add LEAF-2,Raw Good,LEAF-2,4,ea\n";

function makeRequest(body = CSV, contentType = "text/csv"): NextRequest {
  return new NextRequest("http://localhost/api/boms/import", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

const engineer = {
  id: "user-1",
  tenantId: "tenant-1",
  fullName: "Alice",
  role: { permissions: ["file.edit"] },
};

const viewer = {
  id: "user-2",
  tenantId: "tenant-1",
  fullName: "Bob",
  role: { permissions: ["file.view"] },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockTenantUser.current = engineer;
  updates.length = 0;
  insertOrder.length = 0;
  for (const k of Object.keys(inserts)) delete inserts[k];
  for (const k of Object.keys(tableResults)) delete tableResults[k];
});

describe("POST /api/boms/import", () => {
  it("returns 401 when not authenticated", async () => {
    mockTenantUser.current = null;
    expect((await POST(makeRequest())).status).toBe(401);
  });

  it("returns 403 without FILE_EDIT permission", async () => {
    mockTenantUser.current = viewer;
    expect((await POST(makeRequest())).status).toBe(403);
  });

  it("returns 400 for an empty body", async () => {
    const res = await POST(makeRequest(" "));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/empty/i);
  });

  it("returns 400 when the file contains no BOM rows", async () => {
    const res = await POST(makeRequest(`${HEADER}Item,Add X,Raw Good,X,1,ea\n`));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no bom rows/i);
  });

  it("creates every BOM before any item row, so forward references resolve", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    const lastBom = insertOrder.lastIndexOf("boms");
    const firstItem = insertOrder.indexOf("bom_items");
    expect(lastBom).toBeGreaterThanOrEqual(0);
    expect(firstItem).toBeGreaterThan(lastBom);
  });

  it("links a line whose part heads its own BOM, and leaves leaves unlinked", async () => {
    await POST(makeRequest());

    const bomIdByName = new Map(inserts["boms"].map((b) => [b.name as string, b.id as string]));
    const items = inserts["bom_items"];

    const subLine = items.find((i) => i.partNumber === "SUB-1")!;
    expect(subLine.linkedBomId).toBe(bomIdByName.get("SUB-1"));

    const leafLine = items.find((i) => i.partNumber === "LEAF-1")!;
    expect(leafLine.linkedBomId).toBeNull();
  });

  it("gives every line a real partId — no free-text BOM lines", async () => {
    await POST(makeRequest());
    for (const item of inserts["bom_items"]) {
      expect(item.partId).toEqual(expect.any(String));
    }
  });

  it("splits the revision off part numbers on both parts and lines", async () => {
    await POST(makeRequest());

    const leaf = inserts["parts"].find((p) => p.partNumber === "LEAF-1")!;
    expect(leaf.revision).toBe("R2");
    expect(inserts["parts"].some((p) => p.partNumber === "LEAF-1-R2")).toBe(false);

    const line = inserts["bom_items"].find((i) => i.partNumber === "LEAF-1")!;
    expect(line.partNumber).toBe("LEAF-1");
  });

  it("categorises a part that heads a BOM as a sub-assembly", async () => {
    await POST(makeRequest());
    const sub = inserts["parts"].find((p) => p.partNumber === "SUB-1")!;
    expect(sub.category).toBe("SUB_ASSEMBLY");
    const leaf = inserts["parts"].find((p) => p.partNumber === "LEAF-2")!;
    expect(leaf.category).toBe("MANUFACTURED");
  });

  it("carries option group and prompt onto the line", async () => {
    const res = await POST(makeRequest());
    const body = await res.json();

    const opt = inserts["bom_items"].find((i) => i.partNumber === "OPT-A")!;
    expect(opt.optionGroup).toBe("Voltage");
    expect(opt.optionPrompt).toBe("What Voltage ordered");
    expect(body.optionItems).toBe(1);

    const plain = inserts["bom_items"].find((i) => i.partNumber === "LEAF-2")!;
    expect(plain.optionGroup).toBeNull();
  });

  it("skips a BOM whose name already exists rather than duplicating it", async () => {
    tableResults["boms"] = { data: [{ id: "existing-1", name: "SUB-1" }], error: null };

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(body.bomsCreated).toBe(1);
    expect(body.bomsSkipped).toBe(1);
    expect(body.results).toContainEqual({
      partNumber: "SUB-1",
      status: "skipped",
      reason: "A BOM with this name already exists",
    });
    expect(inserts["boms"].map((b) => b.name)).toEqual(["TOP-1"]);
  });

  it("warns when a line points at a sub-assembly that was not created", async () => {
    tableResults["boms"] = { data: [{ id: "existing-1", name: "SUB-1" }], error: null };
    const body = await (await POST(makeRequest())).json();
    expect(body.warnings.join(" ")).toMatch(/SUB-1/);
    expect(body.warnings.join(" ")).toMatch(/leaf items/);
  });

  it("updates an existing part instead of inserting a duplicate", async () => {
    tableResults["parts"] = {
      data: [{ id: "part-existing", partNumber: "LEAF-2", revision: "A", category: "PURCHASED" }],
      error: null,
    };

    const body = await (await POST(makeRequest())).json();
    expect(body.partsUpdated).toBe(1);
    expect(inserts["parts"].some((p) => p.partNumber === "LEAF-2")).toBe(false);
    // The line still resolves to the pre-existing part.
    const line = inserts["bom_items"].find((i) => i.partNumber === "LEAF-2")!;
    expect(line.partId).toBe("part-existing");
  });

  it("reports unusable rows without failing the import", async () => {
    const csv = CSV + "Item,Add BAD,Raw Good,BAD,many,ea\n";
    const body = await (await POST(makeRequest(csv))).json();
    expect(body.bomsCreated).toBe(2);
    expect(body.problems).toHaveLength(1);
    expect(body.problems[0].message).toMatch(/not a positive number/);
  });

  it("logs one audit row per created BOM", async () => {
    await POST(makeRequest());
    expect(logAudit).toHaveBeenCalledTimes(2);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "bom.import", entityType: "bom", userId: "user-1" })
    );
  });

  it("summarises the run", async () => {
    const body = await (await POST(makeRequest())).json();
    expect(body).toMatchObject({
      bomsCreated: 2,
      bomsSkipped: 0,
      itemsCreated: 4,
      optionItems: 1,
    });
    // TOP-1, SUB-1, LEAF-1, LEAF-2, OPT-A
    expect(body.partsCreated).toBe(5);
  });
});
