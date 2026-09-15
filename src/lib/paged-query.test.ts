import { describe, it, expect } from "vitest";
import { selectAll, selectAllIn, IN_FILTER_CHUNK } from "./paged-query";

/** A table that behaves like PostgREST: ordered, and capped per response. */
function table(rowCount: number, maxRows = 1000) {
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    id: `id-${String(i).padStart(5, "0")}`,
  }));
  const calls: { from: number; to: number; ids?: string[] }[] = [];
  const range = (source: typeof rows, from: number, to: number, ids?: string[]) => {
    calls.push({ from, to, ids });
    const end = Math.min(to, from + maxRows - 1);
    return Promise.resolve({ data: source.slice(from, end + 1), error: null });
  };
  return { rows, calls, range };
}

describe("selectAll", () => {
  it("reads past the first 1,000 rows", async () => {
    const t = table(2500);
    const result = await selectAll((from, to) => t.range(t.rows, from, to));
    expect(result).toHaveLength(2500);
    expect(result.at(-1)).toEqual({ id: "id-02499" });
  });

  it("is not fooled by a project whose max-rows is lower than the page it asked for", async () => {
    // Stopping on a short page would end after 500 rows here.
    const t = table(1200, 500);
    const result = await selectAll((from, to) => t.range(t.rows, from, to));
    expect(result).toHaveLength(1200);
  });

  it("throws the database's error instead of returning a partial list", async () => {
    await expect(
      selectAll(() => Promise.resolve({ data: null, error: { message: "timeout" } }))
    ).rejects.toThrow("timeout");
  });

  it("returns an empty list for no rows", async () => {
    const t = table(0);
    expect(await selectAll((from, to) => t.range(t.rows, from, to))).toEqual([]);
  });
});

describe("selectAllIn", () => {
  it("never puts more than a chunk of ids in one request", async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `id-${i}`);
    const seen: number[] = [];
    await selectAllIn(ids, (chunk) => {
      seen.push(chunk.length);
      return Promise.resolve({ data: [], error: null });
    });
    expect(Math.max(...seen)).toBeLessThanOrEqual(IN_FILTER_CHUNK);
    expect(seen.reduce((a, b) => a + b, 0)).toBe(450);
  });

  it("pages within a chunk that matches many rows", async () => {
    const t = table(3000);
    const result = await selectAllIn(["file-1"], (_chunk, from, to) => t.range(t.rows, from, to));
    expect(result).toHaveLength(3000);
  });

  it("asks for each id once", async () => {
    const asked: string[] = [];
    await selectAllIn(["a", "b", "a"], (chunk) => {
      asked.push(...chunk);
      return Promise.resolve({ data: [], error: null });
    });
    expect(asked).toEqual(["a", "b"]);
  });
});
