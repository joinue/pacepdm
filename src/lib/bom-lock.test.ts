import { describe, it, expect } from "vitest";
import { findBomContentLocks, getBomContentLock } from "./bom-lock";
import { ECO_STATUS_FLOW } from "./status-flows";

/**
 * `implement_eco` releases whatever a carried BOM holds when the ECO is
 * implemented. So the lock has to cover the whole window between the ECO
 * being put up for review and it being implemented, and nothing else: an
 * ECO still being authored, or one rejected back to its author, must leave
 * the BOM editable.
 */

type Row = Record<string, unknown>;

/** Minimal query builder: eq / is / in filter, awaiting resolves the rows. */
function fakeDb(tables: Record<string, Row[]>, failOn?: string) {
  return {
    from(table: string) {
      const preds: Array<(r: Row) => boolean> = [];
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, v: unknown) => (preds.push((r) => r[col] === v), chain),
        is: (col: string, v: unknown) => (preds.push((r) => (r[col] ?? null) === v), chain),
        in: (col: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[col])), chain),
        then: (resolve: (v: unknown) => void) =>
          resolve(
            table === failOn
              ? { data: null, error: { message: "connection reset" } }
              : { data: (tables[table] ?? []).filter((r) => preds.every((p) => p(r))), error: null }
          ),
      };
      return chain;
    },
  } as unknown as Parameters<typeof findBomContentLocks>[0];
}

const TENANT = "tenant-1";
const draftBom = { id: "bom-b", status: "DRAFT" };

function carriedBy(ecoStatus: string, overrides: Row = {}) {
  return fakeDb({
    eco_items: [{ ecoId: "eco-1", bomId: "bom-b" }],
    ecos: [
      {
        id: "eco-1",
        tenantId: TENANT,
        ecoNumber: "ECO-0042",
        status: ecoStatus,
        deletedAt: null,
        ...overrides,
      },
    ],
  });
}

describe("BOM content lock — the BOM's own status", () => {
  it.each(["RELEASED", "OBSOLETE"])("locks a %s BOM without asking about ECOs", async (status) => {
    // `failOn` would throw if the ECO tables were queried at all.
    const db = fakeDb({}, "eco_items");
    const lock = await getBomContentLock(db, TENANT, { id: "bom-a", status });
    expect(lock).toMatchObject({ reason: "status", status });
    expect(lock?.message).toMatch(/revise it/i);
  });

  it.each(["DRAFT", "IN_REVIEW", "APPROVED"])(
    "leaves a %s BOM on no ECO editable",
    async (status) => {
      const lock = await getBomContentLock(fakeDb({}), TENANT, { id: "bom-a", status });
      expect(lock).toBeNull();
    }
  );
});

describe("BOM content lock — a change order carrying it", () => {
  it.each(["SUBMITTED", "IN_REVIEW", "APPROVED"])(
    "locks a BOM carried by a %s ECO, naming the ECO",
    async (ecoStatus) => {
      const lock = await getBomContentLock(carriedBy(ecoStatus), TENANT, draftBom);
      expect(lock).toMatchObject({
        reason: "eco",
        ecoId: "eco-1",
        ecoNumber: "ECO-0042",
        ecoStatus,
      });
      expect(lock?.message).toContain("ECO-0042");
    }
  );

  it.each(["DRAFT", "REJECTED", "IMPLEMENTED", "CLOSED"])(
    "does not lock for a %s ECO",
    async (ecoStatus) => {
      expect(await getBomContentLock(carriedBy(ecoStatus), TENANT, draftBom)).toBeNull();
    }
  );

  it("covers every ECO status, so a new one has to be classified here", () => {
    expect(Object.keys(ECO_STATUS_FLOW).sort()).toEqual(
      ["APPROVED", "CLOSED", "DRAFT", "IMPLEMENTED", "IN_REVIEW", "REJECTED", "SUBMITTED"].sort()
    );
  });

  it("tells the user the way out that matches the ECO's status", async () => {
    const approved = await getBomContentLock(carriedBy("APPROVED"), TENANT, draftBom);
    expect(approved?.message).toMatch(/implement the ECO/i);
    const inReview = await getBomContentLock(carriedBy("IN_REVIEW"), TENANT, draftBom);
    expect(inReview?.message).toMatch(/rejected and reworked/i);
  });

  it("ignores a deleted ECO", async () => {
    const db = carriedBy("APPROVED", { deletedAt: "2026-09-01T00:00:00Z" });
    expect(await getBomContentLock(db, TENANT, draftBom)).toBeNull();
  });

  it("ignores another tenant's ECO, so nobody else can lock this tenant's BOM", async () => {
    const db = carriedBy("APPROVED", { tenantId: "tenant-OTHER" });
    expect(await getBomContentLock(db, TENANT, draftBom)).toBeNull();
  });

  it("names the lowest-numbered ECO when more than one carries the BOM", async () => {
    const db = fakeDb({
      eco_items: [
        { ecoId: "eco-9", bomId: "bom-b" },
        { ecoId: "eco-3", bomId: "bom-b" },
      ],
      ecos: [
        {
          id: "eco-9",
          tenantId: TENANT,
          ecoNumber: "ECO-0009",
          status: "SUBMITTED",
          deletedAt: null,
        },
        {
          id: "eco-3",
          tenantId: TENANT,
          ecoNumber: "ECO-0003",
          status: "APPROVED",
          deletedAt: null,
        },
      ],
    });
    const lock = await getBomContentLock(db, TENANT, draftBom);
    expect(lock).toMatchObject({ reason: "eco", ecoNumber: "ECO-0003" });
  });

  it("answers for many BOMs at once, leaving unlocked ones out of the map", async () => {
    const db = fakeDb({
      eco_items: [{ ecoId: "eco-1", bomId: "bom-b" }],
      ecos: [
        { id: "eco-1", tenantId: TENANT, ecoNumber: "ECO-1", status: "IN_REVIEW", deletedAt: null },
      ],
    });
    const locks = await findBomContentLocks(db, TENANT, [
      { id: "bom-a", status: "RELEASED" },
      { id: "bom-b", status: "DRAFT" },
      { id: "bom-c", status: "DRAFT" },
    ]);
    expect(locks.get("bom-a")?.reason).toBe("status");
    expect(locks.get("bom-b")?.reason).toBe("eco");
    expect(locks.has("bom-c")).toBe(false);
  });

  it.each(["eco_items", "ecos"])("fails closed when the %s query errors", async (table) => {
    const tables = {
      eco_items: [{ ecoId: "eco-1", bomId: "bom-b" }],
      ecos: [
        { id: "eco-1", tenantId: TENANT, ecoNumber: "ECO-1", status: "DRAFT", deletedAt: null },
      ],
    };
    await expect(getBomContentLock(fakeDb(tables, table), TENANT, draftBom)).rejects.toThrow(
      /connection reset/
    );
  });
});
