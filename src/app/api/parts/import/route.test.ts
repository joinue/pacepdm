import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The importer's contract is "bad rows are reported, good rows land" — it is
 * deliberately not transactional, because a 500-row spreadsheet with three bad
 * rows should land the 497.
 *
 * These tests cover the third outcome that sits between those two: a row that
 * lands but carries something worth a second look. Today that is a revision
 * using a letter ASME Y14.35 reserves. An imported part at revision `S` is a
 * fact about the source system, not a mistake this importer gets to refuse —
 * but `nextRevision` cannot sequence it, so the first person to revise that
 * part will be asked for the next revision by hand, and the import is where
 * they should find out why.
 */

const { tableResults, inserts, updates, mockFrom } = vi.hoisted(() => {
  type QueryResult = { data: unknown; error: unknown };
  const tableResults: Record<string, QueryResult> = {};
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];

  function makeChain(table: string) {
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    const resolvable = () => tableResults[table] ?? { data: null, error: null };
    for (const m of ["select", "eq", "in", "is", "order", "limit"] as const) chain[m] = () => chain;
    chain.single = () => resolvable();
    chain.maybeSingle = () => resolvable();
    chain.insert = (data: unknown) => {
      inserts.push(data as Record<string, unknown>);
      return Promise.resolve({ data: null, error: null });
    };
    chain.update = (data: unknown) => {
      updates.push(data as Record<string, unknown>);
      const u: Record<string, (...a: unknown[]) => unknown> = {};
      u.eq = () => u;
      u.then = ((r: (v: unknown) => void) => r({ data: null, error: null })) as never;
      return u;
    };
    chain.then = ((r: (v: unknown) => void) => r(resolvable())) as never;
    return chain;
  }

  return { tableResults, inserts, updates, mockFrom: (t: string) => makeChain(t) };
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
vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return { ...actual, getApiTenantUser: () => Promise.resolve(mockTenantUser.current) };
});
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("uuid", () => ({ v4: () => "mock-uuid" }));

import { POST } from "./route";

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

function csv(body: string): NextRequest {
  return new NextRequest("http://localhost/api/parts/import", {
    method: "POST",
    headers: { "content-type": "text/csv" },
    body,
  });
}

const HEADER = "Part Number,Name,Revision";

beforeEach(() => {
  vi.clearAllMocks();
  inserts.length = 0;
  updates.length = 0;
  for (const k of Object.keys(tableResults)) delete tableResults[k];
  tableResults.parts = { data: [], error: null }; // nothing exists yet
  mockTenantUser.current = engineer;
});

describe("POST /api/parts/import — access and shape", () => {
  it("401s without a session", async () => {
    mockTenantUser.current = null;
    expect((await POST(csv(`${HEADER}\nPN-1,Bracket,A`))).status).toBe(401);
  });

  it("403s without file.edit — import is not a lower bar than the UI", async () => {
    mockTenantUser.current = viewer;
    expect((await POST(csv(`${HEADER}\nPN-1,Bracket,A`))).status).toBe(403);
  });

  it("400s on an empty body", async () => {
    expect((await POST(csv("   "))).status).toBe(400);
  });

  it("400s when the part number column is missing", async () => {
    const res = await POST(csv("Name,Revision\nBracket,A"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/part number/i);
  });

  it("400s when the name column is missing", async () => {
    const res = await POST(csv("Part Number,Revision\nPN-1,A"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/name/i);
  });

  it("refuses more than 1000 rows rather than hammering the database", async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => `PN-${i},Part ${i},A`).join("\n");
    const res = await POST(csv(`${HEADER}\n${rows}`));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/too many rows/i);
  });
});

describe("POST /api/parts/import — reserved revision letters", () => {
  it.each(["I", "O", "Q", "S", "X", "Z"])(
    "warns on revision %s but still imports it",
    async (rev) => {
      const res = await POST(csv(`${HEADER}\nPN-1,Bracket,${rev}`));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.inserted).toBe(1);
      expect(body.failed).toBe(0);
      expect(body.warned).toBe(1);

      // The row landed, at the revision the source system gave it.
      expect(inserts).toHaveLength(1);
      expect(inserts[0].revision).toBe(rev);

      expect(body.results[0].warning).toContain("Y14.35");
      expect(body.results[0].action).toBe("inserted");
      expect(body.results[0].error).toBeUndefined();
    }
  );

  it.each(["A", "B", "AA", "R2", "1", "09"])("does not warn on %s", async (rev) => {
    const body = await (await POST(csv(`${HEADER}\nPN-1,Bracket,${rev}`))).json();
    expect(body.warned).toBe(0);
    expect(body.results[0].warning).toBeUndefined();
  });

  /**
   * A mixed revision like `AS` contains a reserved letter too, and is equally
   * unsequenceable — the check is per-letter, not per-first-letter.
   */
  it("warns on a multi-letter revision containing a reserved letter", async () => {
    const body = await (await POST(csv(`${HEADER}\nPN-1,Bracket,AS`))).json();
    expect(body.warned).toBe(1);
  });

  it("does not warn when the revision column is empty", async () => {
    const body = await (await POST(csv(`${HEADER}\nPN-1,Bracket,`))).json();
    expect(body.warned).toBe(0);
    // Absent revision still defaults to A on insert.
    expect(inserts[0].revision).toBe("A");
  });

  it("warns per row, not per import", async () => {
    const body = await (
      await POST(csv(`${HEADER}\nPN-1,Bracket,S\nPN-2,Housing,B\nPN-3,Shaft,Z`))
    ).json();
    expect(body.inserted).toBe(3);
    expect(body.warned).toBe(2);
    expect(body.results.map((r: { warning?: string }) => !!r.warning)).toEqual([true, false, true]);
  });

  /**
   * A warning is not a failure. Conflating them would make the summary read
   * as "2 rows did not import" when all of them did.
   */
  it("keeps warned rows out of the failed count", async () => {
    // Three rows, one of each outcome: one warned-but-landed, one clean, one
    // genuinely rejected. Each counter must see only its own.
    const body = await (
      await POST(csv(`${HEADER}\nPN-1,Bracket,S\nPN-2,Housing,B\n,NoNumber,A`))
    ).json();
    expect(body.warned).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.inserted).toBe(2);
    expect(body.total).toBe(3);

    const [warned, clean, rejected] = body.results;
    expect(warned).toMatchObject({
      action: "inserted",
      warning: expect.stringContaining("Y14.35"),
    });
    expect(clean.warning).toBeUndefined();
    expect(rejected).toMatchObject({ action: "failed", error: "Missing Part Number" });
    // A failed row carries no warning — it never got as far as being assessed.
    expect(rejected.warning).toBeUndefined();
  });

  it("warns on an updated row as well as an inserted one", async () => {
    tableResults.parts = { data: [{ id: "part-1", partNumber: "PN-1" }], error: null };
    const body = await (await POST(csv(`${HEADER}\nPN-1,Bracket,S`))).json();
    expect(body.updated).toBe(1);
    expect(body.inserted).toBe(0);
    expect(body.warned).toBe(1);
    expect(body.results[0].warning).toContain("Y14.35");
  });
});

describe("POST /api/parts/import — row outcomes", () => {
  it("reports a bad row and still lands the good ones", async () => {
    const body = await (
      await POST(csv(`${HEADER}\nPN-1,Bracket,A\n,NoNumber,A\nPN-3,Shaft,B`))
    ).json();
    expect(body.inserted).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.results[1]).toMatchObject({ action: "failed", error: "Missing Part Number" });
  });

  it("rejects an unknown category with the allowed list", async () => {
    const body = await (await POST(csv("Part Number,Name,Category\nPN-1,Bracket,WIDGETS"))).json();
    expect(body.failed).toBe(1);
    expect(body.results[0].error).toMatch(/invalid category/i);
    expect(body.results[0].error).toMatch(/MANUFACTURED/);
  });

  it("numbers rows from 2, so a row number matches the spreadsheet", async () => {
    const body = await (await POST(csv(`${HEADER}\nPN-1,Bracket,A\nPN-2,Housing,B`))).json();
    expect(body.results.map((r: { row: number }) => r.row)).toEqual([2, 3]);
  });
});
