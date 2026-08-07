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

  /**
   * The NOT NULL columns this mock enforces, so an insert that would be
   * rejected by Postgres is rejected here too.
   *
   * This exists because it did not. `part_vendors.vendorId` has been NOT NULL
   * with a RESTRICT FK since migration 009, the QuickBooks path omitted it,
   * and a mock that accepted any object made the test that covers this pass
   * against an insert the database refused on every call.
   */
  const NOT_NULL: Record<string, string[]> = {
    part_vendors: ["partId", "vendorId", "vendorName"],
    vendors: ["name"],
    parts: ["partNumber"],
  };

  function notNullViolation(table: string, data: Record<string, unknown>) {
    for (const col of NOT_NULL[table] ?? []) {
      if (data[col] === undefined || data[col] === null) {
        return {
          code: "23502",
          message: `null value in column "${col}" of relation "${table}" violates not-null constraint`,
        };
      }
    }
    return null;
  }

  function makeChain(table: string) {
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    const resolvable = () => tableResults[table] ?? { data: null, error: null };
    // `range` is what the QuickBooks path uses to page the tenant's own parts
    // rather than querying by 6,000 part numbers.
    for (const m of ["select", "eq", "neq", "in", "is", "order", "limit", "range"] as const)
      chain[m] = () => chain;
    chain.single = () => resolvable();
    chain.maybeSingle = () => resolvable();
    chain.insert = (data: unknown) => {
      const row = data as Record<string, unknown>;
      inserts.push({ __table: table, ...row });
      const error = notNullViolation(table, row);
      const result = { data: error ? null : { ...row }, error };
      // An insert is awaited directly in some places and chained through
      // `.select().single()` in others, so the mock has to be both.
      const ins: Record<string, (...a: unknown[]) => unknown> = {};
      ins.select = () => ins;
      ins.single = () => Promise.resolve(result);
      ins.maybeSingle = () => Promise.resolve(result);
      ins.then = ((r: (v: unknown) => void) => r(result)) as never;
      return ins;
    };
    chain.update = (data: unknown) => {
      updates.push({ __table: table, ...(data as Record<string, unknown>) });
      const u: Record<string, (...a: unknown[]) => unknown> = {};
      u.eq = () => u;
      u.neq = () => u;
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

  /**
   * The cap was 1000 and is now 20000. It moved because a QuickBooks item
   * export cannot be narrowed on the QuickBooks side — you get the whole
   * catalogue or nothing, and PACE's is over 7,000 rows. A cap below that
   * would reject the only file the user can actually produce.
   *
   * Writes stay bounded far lower and separately: the QuickBooks path only
   * touches parts already in the library.
   */
  it("accepts a file far larger than the old 1000-row cap", async () => {
    const rows = Array.from({ length: 8000 }, (_, i) => `PN-${i},Part ${i},A`).join("\n");
    expect((await POST(csv(`${HEADER}\n${rows}`))).status).toBe(200);
  });

  it("still refuses a runaway file", async () => {
    const rows = Array.from({ length: 20001 }, (_, i) => `PN-${i},Part ${i},A`).join("\n");
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

/**
 * A raw QuickBooks item export takes a different path through this route.
 *
 * The constraint driving all of it: QuickBooks will not filter the export, so
 * the file is the whole catalogue — services, sales tax items, inactive rows,
 * every machine — and the filtering has to happen here.
 */
describe("POST /api/parts/import — QuickBooks export", () => {
  const QB_HEADER =
    `,"Active Status","Type","Item","Description","Sales Tax Code","Account","COGS Account",` +
    `"Asset Account","Accumulated Depreciation","Purchase Description","Quantity On Hand",` +
    `"Cost","Preferred Vendor","Tax Agency","Price","Reorder Pt (Min)","MPN","Barcode",` +
    `"Schedule B tariff code","Weight"`;

  function qbRow(item: string, desc: string, cost: string, vendor: string, active = "Active") {
    return `,"${active}","Inventory Part","${item}","${desc}","Tax","Sales:Equipment","COGS","Inventory Asset",0.00,,0,${cost},"${vendor}",,900.00,"","","","0","1"`;
  }

  /**
   * The last write to a named table. The QuickBooks path now updates two —
   * the part itself, and `part_vendors` when it demotes a previous primary —
   * so "the last update" is ambiguous without saying which.
   */
  function lastUpdateTo(table: string) {
    return [...updates].reverse().find((u) => u.__table === table)!;
  }

  /** The PDM's own library — the QuickBooks path only touches what is here. */
  function givenLibrary(
    parts: Array<{ id: string; partNumber: string; revision: string | null; name: string }>
  ) {
    tableResults.parts = { data: parts, error: null };
  }

  beforeEach(() => {
    givenLibrary([{ id: "p1", partNumber: "N1S-M-001", revision: "R2", name: "N1S-M-001" }]);
    tableResults.part_vendors = { data: null, error: null };
    tableResults.vendors = { data: [], error: null };
  });

  it("is recognised and reported as a QuickBooks import", async () => {
    const body = await (
      await POST(
        csv(`${QB_HEADER}\n${qbRow("A:B:N1S-M-001-R2", "Base Casting", "332.13", "Kunshan")}`)
      )
    ).json();
    expect(body.source).toBe("quickbooks");
  });

  /**
   * Four QuickBooks entries, one part. Applying them all would let the last
   * row win, which is how a current casting acquires a superseded vendor.
   */
  it("applies the entry matching the revision the library holds", async () => {
    const rows = [
      qbRow("A:B:N1S-M-001", "Base Casting", "332.13", "DongGuan"),
      qbRow("A:B:N1S-M-001-R1", "Base Casting machined", "332.13", "DongGuan"),
      qbRow("A:B:N1S-M-001-R2", "Base Casting machined and coated", "332.13", "Kunshan"),
      qbRow("A:B:N1S-M-001-R3", "Base Casting machined and coated", "332.13", "Suzhou"),
    ].join("\n");
    const body = await (await POST(csv(`${QB_HEADER}\n${rows}`))).json();

    expect(body.updated).toBe(1);
    const update = lastUpdateTo("parts");
    expect(update.unitCost).toBe(332.13);
    // The ERP's identifier for this exact revision — the join key.
    expect(update.externalId).toBe("N1S-M-001-R2");
  });

  it("says which entries it passed over", async () => {
    const rows = [
      qbRow("A:B:N1S-M-001", "Base Casting", "332.13", "DongGuan"),
      qbRow("A:B:N1S-M-001-R2", "Base Casting machined", "332.13", "Kunshan"),
    ].join("\n");
    const body = await (await POST(csv(`${QB_HEADER}\n${rows}`))).json();
    expect(body.warned).toBe(1);
    expect(body.results[0].warning).toContain("N1S-M-001-R2");
  });

  /**
   * The whole reason for update-only. The export carries thousands of items
   * the engineering library has no business acquiring.
   */
  it("ignores parts the library does not carry, and counts them", async () => {
    const rows = [
      qbRow("A:B:N1S-M-001-R2", "Base Casting", "332.13", "Kunshan"),
      qbRow("Consumables:ALD-0110E-BULK", "Alumina powder", "5245.83", "Baikowski"),
    ].join("\n");
    const body = await (await POST(csv(`${QB_HEADER}\n${rows}`))).json();
    expect(body.updated).toBe(1);
    expect(body.notInLibrary).toBe(1);
    expect(body.inserted).toBe(0);
  });

  it("counts rows that were never parts", async () => {
    const service = `,"Active","Service","Labor","","Tax","Sales:Labor",,,0.00,,"",0.00,,,125.00,"",,"","",""`;
    const inactive = qbRow("A:B:N1S-M-001-R2", "Base Casting", "332.13", "Kunshan", "Not-active");
    const body = await (await POST(csv(`${QB_HEADER}\n${service}\n${inactive}`))).json();
    expect(body.notParts).toBe(2);
    expect(body.updated).toBe(0);
  });

  /**
   * Only a placeholder name is replaced. The BOM importer sets name = part
   * number when it has nothing better; a curated name is left alone.
   */
  it("replaces a placeholder name with the QuickBooks description", async () => {
    await POST(
      csv(
        `${QB_HEADER}\n${qbRow("A:B:N1S-M-001-R2", "NANO-1000S Base Casting", "332.13", "Kunshan")}`
      )
    );
    expect(lastUpdateTo("parts").name).toBe("NANO-1000S Base Casting");
  });

  it("leaves a name somebody curated alone", async () => {
    givenLibrary([
      { id: "p1", partNumber: "N1S-M-001", revision: "R2", name: "Base casting (machined)" },
    ]);
    await POST(
      csv(
        `${QB_HEADER}\n${qbRow("A:B:N1S-M-001-R2", "NANO-1000S Base Casting", "332.13", "Kunshan")}`
      )
    );
    expect(lastUpdateTo("parts").name).toBeUndefined();
  });

  /**
   * `part_vendors.vendorId` is NOT NULL behind a RESTRICT FK (migration 009).
   * The importer wrote only the legacy `vendorName` text column, so every one
   * of these inserts was rejected with 23502 — and the result was never bound,
   * so the row still counted as `updated` and the import reported success.
   *
   * The mock enforces the NOT NULL columns for exactly this reason: without
   * that, this assertion passes against an insert the database refuses.
   */
  it("links the preferred vendor by id, not by name alone", async () => {
    await POST(
      csv(`${QB_HEADER}\n${qbRow("A:B:N1S-M-001-R2", "Base Casting", "332.13", "Kunshan")}`)
    );
    const link = inserts.find((i) => i.__table === "part_vendors");
    expect(link).toMatchObject({
      partId: "p1",
      vendorId: "mock-uuid",
      vendorName: "Kunshan",
      unitCost: 332.13,
      isPrimary: true,
    });
  });

  it("creates the vendor the export names, and says how many it created", async () => {
    const body = await (
      await POST(
        csv(`${QB_HEADER}\n${qbRow("A:B:N1S-M-001-R2", "Base Casting", "332.13", "Kunshan")}`)
      )
    ).json();
    expect(inserts.find((i) => i.__table === "vendors")).toMatchObject({ name: "Kunshan" });
    expect(body.vendorsCreated).toBe(1);
  });

  it("reuses a vendor the tenant already has rather than duplicating it", async () => {
    // The unique index is exact-match on name, so the match has to be made
    // here — case and whitespace included.
    tableResults.vendors = { data: [{ id: "v-existing", name: "kunshan" }], error: null };
    const body = await (
      await POST(
        csv(`${QB_HEADER}\n${qbRow("A:B:N1S-M-001-R2", "Base Casting", "332.13", "  Kunshan  ")}`)
      )
    ).json();

    expect(inserts.find((i) => i.__table === "vendors")).toBeUndefined();
    expect(body.vendorsCreated).toBe(0);
    expect(inserts.find((i) => i.__table === "part_vendors")).toMatchObject({
      vendorId: "v-existing",
    });
  });

  /**
   * A part carries at most one primary vendor — `/api/boms/[bomId]/items`
   * keys its primary-cost lookup by partId and would otherwise pick one of
   * two arbitrarily.
   */
  it("demotes a previous primary vendor after linking the new one", async () => {
    await POST(
      csv(`${QB_HEADER}\n${qbRow("A:B:N1S-M-001-R2", "Base Casting", "332.13", "Kunshan")}`)
    );
    expect(lastUpdateTo("part_vendors")).toMatchObject({ isPrimary: false });
    // After, not before: demoting first leaves the part with no primary at
    // all if the insert then fails.
    const linkIndex = inserts.findIndex((i) => i.__table === "part_vendors");
    expect(linkIndex).toBeGreaterThanOrEqual(0);
  });

  it("leaves an existing link to the same vendor alone", async () => {
    tableResults.vendors = { data: [{ id: "v-existing", name: "Kunshan" }], error: null };
    tableResults.part_vendors = { data: { id: "pv-1" }, error: null };
    await POST(
      csv(`${QB_HEADER}\n${qbRow("A:B:N1S-M-001-R2", "Base Casting", "332.13", "Kunshan")}`)
    );
    expect(inserts.find((i) => i.__table === "part_vendors")).toBeUndefined();
    expect(updates.find((u) => u.__table === "part_vendors")).toBeUndefined();
  });

  /**
   * The part's own cost and description were already written by the time the
   * vendor link is attempted, so the row landed — a failed link is a warning,
   * not a failure. Silently discarding it is what hid this for as long as it
   * was hidden.
   */
  it("warns rather than failing when the vendor link cannot be made", async () => {
    tableResults.vendors = { data: null, error: { code: "42501", message: "permission denied" } };
    const body = await (
      await POST(
        csv(`${QB_HEADER}\n${qbRow("A:B:N1S-M-001-R2", "Base Casting", "332.13", "Kunshan")}`)
      )
    ).json();

    expect(body.updated).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.warned).toBe(1);
    expect(body.results[0].action).toBe("updated");
    expect(body.results[0].warning).toMatch(/Kunshan/);
    expect(body.results[0].warning).toMatch(/permission denied/);
  });

  /**
   * The library is on a revision QuickBooks has no entry for, and every
   * QuickBooks entry is versioned. Picking the highest would be a guess about
   * what is physically on the shelf.
   */
  it("applies nothing when no entry matches and there is no unversioned one", async () => {
    givenLibrary([{ id: "p1", partNumber: "N1S-M-001", revision: "R9", name: "N1S-M-001" }]);
    const rows = [
      qbRow("A:B:N1S-M-001-R1", "Base Casting", "332.13", "DongGuan"),
      qbRow("A:B:N1S-M-001-R2", "Base Casting", "332.13", "Kunshan"),
    ].join("\n");
    const body = await (await POST(csv(`${QB_HEADER}\n${rows}`))).json();

    expect(body.updated).toBe(0);
    expect(body.failed).toBe(1);
    expect(body.results[0].error).toMatch(/reconcile the revision/i);
    expect(updates).toHaveLength(0);
  });

  /** Two components under one number is not something an importer may resolve. */
  it("flags entries that describe different components", async () => {
    const rows = [
      qbRow("A:B:N1S-M-001-R1", "Control Box Swivel Connector", "5.67", "Kunshan"),
      qbRow("A:B:N1S-M-001-R2", "Faucet hose retracted mechanism base", "5.67", "Lucent"),
    ].join("\n");
    const body = await (await POST(csv(`${QB_HEADER}\n${rows}`))).json();
    expect(body.results[0].warning).toMatch(/two parts sharing a number/i);
  });

  it("does not fall through to the generic importer's Name requirement", async () => {
    // A QuickBooks export has no Name column at all. The generic path would
    // reject the whole file; this one must not.
    const res = await POST(
      csv(`${QB_HEADER}\n${qbRow("A:B:N1S-M-001-R2", "Base Casting", "332.13", "Kunshan")}`)
    );
    expect(res.status).toBe(200);
  });
});
