import { describe, it, expect } from "vitest";
import {
  sequenceFromPartNumber,
  formatPartNumber,
  nextPartNumberSequence,
  advancePartNumberSequence,
  advanceSequencePastNumbers,
  highestTakenSequence,
  type PartNumberSettings,
} from "./parts";

const settings: PartNumberSettings = { mode: "AUTO", prefix: "PRT-", padding: 5 };

type Row = Record<string, unknown>;

/**
 * Just enough of PostgREST for the numbering helpers: equality filters, the
 * `match` regex operator, ordering, limit and range on reads, and an update
 * that reports the rows it matched — which is what the compare-and-swap reads.
 *
 * `beforeWrite` runs between a read and the update that follows it, so a test
 * can play a concurrent allocator landing in exactly that gap.
 */
function fakeDb(tables: Record<string, Row[]>, beforeWrite?: () => void) {
  function query(table: string) {
    const preds: Array<(r: Row) => boolean> = [];
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
    const q: Record<string, unknown> = {
      eq: (col: string, v: unknown) => (preds.push((r) => r[col] === v), q),
      filter: (col: string, op: string, pattern: string) => {
        if (op !== "match") throw new Error(`unsupported operator ${op}`);
        const re = new RegExp(pattern);
        preds.push((r) => re.test(String(r[col])));
        return q;
      },
      order: (col: string, opts?: { ascending?: boolean }) => (
        (order = { col, ascending: opts?.ascending ?? true }),
        q
      ),
      limit: (n: number) => ((limit = n), q),
      range: (from: number, to: number) => ((range = [from, to]), q),
      single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => resolve({ data: rows(), error: null }),
    };
    return { q, preds };
  }

  return {
    from(table: string) {
      return {
        select: () => query(table).q,
        update(values: Row) {
          const { q, preds } = query(table);
          return Object.assign(q, {
            select: () => ({
              then: (resolve: (v: unknown) => void) => {
                beforeWrite?.();
                const matched = (tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
                for (const r of matched) Object.assign(r, values);
                resolve({ data: matched, error: null });
              },
            }),
          });
        },
      };
    },
  } as never;
}

const parts = (...numbers: string[]) =>
  numbers.map((partNumber, i) => ({ id: `p-${i}`, tenantId: "t1", partNumber }));

describe("sequenceFromPartNumber", () => {
  it("reads the sequence out of a number the counter could have minted", () => {
    expect(sequenceFromPartNumber("PRT-00042", settings)).toBe(42);
    expect(sequenceFromPartNumber("PRT-00000", settings)).toBe(0);
  });

  it("reads a number that has outgrown the padding", () => {
    expect(sequenceFromPartNumber("PRT-123456", settings)).toBe(123456);
  });

  it("ignores numbers that could never collide with one the counter mints", () => {
    for (const pn of ["PRT-42", "prt-00042", "PRT-00042-A", "PRT-0123456", "ABC-00042", "PRT-"]) {
      expect(sequenceFromPartNumber(pn, settings)).toBeNull();
    }
  });

  it("round-trips with formatPartNumber for a prefix with regex characters in it", () => {
    const odd: PartNumberSettings = { mode: "AUTO", prefix: "A.(1)+", padding: 3 };
    expect(sequenceFromPartNumber(formatPartNumber(7, odd), odd)).toBe(7);
  });

  it("ignores a number past what the INTEGER counter can hold", () => {
    expect(sequenceFromPartNumber("PRT-99999999999", settings)).toBeNull();
  });
});

describe("nextPartNumberSequence", () => {
  it("retries when another allocator takes the slot between its read and its write", async () => {
    const tables = { tenants: [{ id: "t1", partNumberSequence: 5 }] };
    let raced = false;
    const db = fakeDb(tables, () => {
      if (!raced) {
        raced = true;
        tables.tenants[0].partNumberSequence = 6; // the other caller got 6
      }
    });
    expect(await nextPartNumberSequence(db, "t1")).toBe(7);
    expect(tables.tenants[0].partNumberSequence).toBe(7);
  });
});

describe("advancePartNumberSequence", () => {
  it("raises the counter", async () => {
    const tables = { tenants: [{ id: "t1", partNumberSequence: 3 }] };
    await advancePartNumberSequence(fakeDb(tables), "t1", 42);
    expect(tables.tenants[0].partNumberSequence).toBe(42);
  });

  it("never lowers it", async () => {
    const tables = { tenants: [{ id: "t1", partNumberSequence: 50 }] };
    await advancePartNumberSequence(fakeDb(tables), "t1", 42);
    expect(tables.tenants[0].partNumberSequence).toBe(50);
  });

  it("does not undo an allocation that lands between its read and its write", async () => {
    const tables = { tenants: [{ id: "t1", partNumberSequence: 10 }] };
    let raced = false;
    const db = fakeDb(tables, () => {
      if (!raced) {
        raced = true;
        tables.tenants[0].partNumberSequence = 60; // someone allocated far ahead
      }
    });
    await advancePartNumberSequence(db, "t1", 42);
    expect(tables.tenants[0].partNumberSequence).toBe(60);
  });
});

describe("highestTakenSequence", () => {
  it("finds the highest padded number the format could mint", async () => {
    const tables = {
      parts: parts("PRT-00007", "PRT-00042", "PRT-00019", "PRT-99", "N1S-00500", "PRT-00100-A"),
    };
    expect(await highestTakenSequence(fakeDb(tables), "t1", settings)).toBe(42);
  });

  it("prefers a number that outgrew the padding, which text order would rank lower", async () => {
    // "PRT-99999" sorts after "PRT-100000" as text.
    const tables = { parts: parts("PRT-99999", "PRT-100000", "PRT-00001") };
    expect(await highestTakenSequence(fakeDb(tables), "t1", settings)).toBe(100000);
  });

  it("counts only the caller's tenant", async () => {
    const tables = {
      parts: [
        { id: "a", tenantId: "t1", partNumber: "PRT-00003" },
        { id: "b", tenantId: "t2", partNumber: "PRT-00900" },
      ],
    };
    expect(await highestTakenSequence(fakeDb(tables), "t1", settings)).toBe(3);
  });

  it("is 0 when nothing matches", async () => {
    expect(await highestTakenSequence(fakeDb({ parts: parts("N1S-002") }), "t1", settings)).toBe(0);
  });
});

describe("advanceSequencePastNumbers", () => {
  it("moves the counter to the highest number in the list the format could mint", async () => {
    const tables = { tenants: [{ id: "t1", partNumberSequence: 0 }] };
    await advanceSequencePastNumbers(fakeDb(tables), "t1", settings, [
      "PRT-00012",
      "PRT-00300",
      "OTHER-1",
    ]);
    expect(tables.tenants[0].partNumberSequence).toBe(300);
  });

  it("does nothing when no number in the list matches", async () => {
    const tables = { tenants: [{ id: "t1", partNumberSequence: 4 }] };
    await advanceSequencePastNumbers(fakeDb(tables), "t1", settings, ["N1S-002"]);
    expect(tables.tenants[0].partNumberSequence).toBe(4);
  });
});
