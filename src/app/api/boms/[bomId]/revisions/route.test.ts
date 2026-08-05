import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Revision lineage walking.
 *
 * The chain is walked backwards through `previousRevisionId` and forwards by
 * asking who points back at the current row. Both directions need a cycle
 * guard: a corrupt link would otherwise spin against the database until the
 * request times out, and this endpoint is on the BOM detail page, so it runs
 * every time anyone opens a BOM.
 *
 * The fixtures below model A → B → C, where A and B are superseded.
 */

const { mockFrom, rows } = vi.hoisted(() => {
  interface BomRow {
    id: string;
    name: string;
    revision: string;
    status: string;
    previousRevisionId: string | null;
    supersededById: string | null;
    createdAt: string;
    updatedAt: string;
    createdById: string | null;
  }
  const rows: { boms: BomRow[] } = { boms: [] };

  function makeChain(table: string) {
    const filters: Record<string, unknown> = {};
    const chain: Record<string, (...args: unknown[]) => unknown> = {};

    const resolve = () => {
      if (table !== "boms") return { data: [], error: null };
      let out = rows.boms;
      if (filters.id !== undefined) out = out.filter((r) => r.id === filters.id);
      if (filters.previousRevisionId !== undefined) {
        out = out.filter((r) => r.previousRevisionId === filters.previousRevisionId);
      }
      return { data: out, error: null };
    };

    for (const m of ["select", "is", "order", "limit", "in"] as const) chain[m] = () => chain;
    chain.eq = (col: unknown, val: unknown) => {
      filters[col as string] = val;
      return chain;
    };
    chain.maybeSingle = () => {
      const r = resolve();
      return { data: (r.data as unknown[])[0] ?? null, error: null };
    };
    chain.single = chain.maybeSingle;
    chain.then = ((res: (v: unknown) => void) => res(resolve())) as unknown as (
      ...a: unknown[]
    ) => unknown;
    return chain;
  }

  return { rows, mockFrom: (t: string) => makeChain(t) };
});

const mockTenantUser = vi.hoisted(() => ({
  current: {
    id: "u1",
    tenantId: "tenant-1",
    fullName: "Alice",
    role: { permissions: ["file.view"] },
  } as { id: string; tenantId: string; fullName: string; role: { permissions: string[] } } | null,
}));

vi.mock("@/lib/db", () => ({ getServiceClient: () => ({ from: mockFrom }) }));
vi.mock("@/lib/auth", () => ({
  getApiTenantUser: () => Promise.resolve(mockTenantUser.current),
}));

import { GET } from "./route";

const ID = {
  a: "aaaaaaaa-1111-4111-8111-111111111111",
  b: "bbbbbbbb-2222-4222-8222-222222222222",
  c: "cccccccc-3333-4333-8333-333333333333",
};

function bom(over: Partial<Record<string, unknown>> & { id: string }) {
  return {
    name: "NANO-1000S",
    revision: "A",
    status: "RELEASED",
    previousRevisionId: null,
    supersededById: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    createdById: null,
    ...over,
  } as never;
}

async function call(bomId: string) {
  const res = await GET(new NextRequest(`http://localhost/api/boms/${bomId}/revisions`), {
    params: Promise.resolve({ bomId }),
  });
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  rows.boms = [
    bom({
      id: ID.a,
      revision: "A",
      status: "OBSOLETE",
      supersededById: ID.b,
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    bom({
      id: ID.b,
      revision: "B",
      status: "OBSOLETE",
      previousRevisionId: ID.a,
      supersededById: ID.c,
      createdAt: "2026-02-01T00:00:00.000Z",
    }),
    bom({
      id: ID.c,
      revision: "C",
      status: "RELEASED",
      previousRevisionId: ID.b,
      createdAt: "2026-03-01T00:00:00.000Z",
    }),
  ];
});

describe("BOM revision lineage", () => {
  it("returns the whole chain oldest-first when asked from the newest", async () => {
    const { body } = await call(ID.c);
    expect(body.map((r: { revision: string }) => r.revision)).toEqual(["A", "B", "C"]);
  });

  it("returns the same chain when asked from the oldest", async () => {
    // The panel serves both directions from one response — "what came
    // before" on a current revision and "what replaced this" on an old one.
    const { body } = await call(ID.a);
    expect(body.map((r: { revision: string }) => r.revision)).toEqual(["A", "B", "C"]);
  });

  it("marks only the unsuperseded revision as current", async () => {
    const { body } = await call(ID.a);
    expect(body.filter((r: { isCurrent: boolean }) => r.isCurrent)).toHaveLength(1);
    expect(body.find((r: { isCurrent: boolean }) => r.isCurrent).revision).toBe("C");
  });

  it("flags which revision was asked for", async () => {
    const { body } = await call(ID.b);
    const requested = body.filter((r: { isRequested: boolean }) => r.isRequested);
    expect(requested).toHaveLength(1);
    expect(requested[0].revision).toBe("B");
  });

  it("exposes releasedAt only once a revision is released or obsolete", async () => {
    rows.boms.push(
      bom({
        id: "dddddddd-4444-4444-8444-444444444444",
        revision: "D",
        status: "DRAFT",
        previousRevisionId: ID.c,
        createdAt: "2026-04-01T00:00:00.000Z",
      })
    );
    const { body } = await call(ID.c);
    const draft = body.find((r: { revision: string }) => r.revision === "D");
    expect(draft.releasedAt).toBeNull();
    const released = body.find((r: { revision: string }) => r.revision === "C");
    expect(released.releasedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("terminates on a cycle instead of walking forever", async () => {
    // A corrupt link. Without the `seen` guard this walks until the request
    // dies, on an endpoint that runs every time a BOM is opened.
    rows.boms = [
      bom({ id: ID.a, revision: "A", previousRevisionId: ID.b }),
      bom({ id: ID.b, revision: "B", previousRevisionId: ID.a }),
    ];
    const { body } = await call(ID.a);
    expect(body).toHaveLength(2);
  });

  it("stops cleanly when an ancestor has been deleted", async () => {
    // B points at an A that no longer resolves — the chain just starts later
    // rather than erroring.
    rows.boms = [
      bom({ id: ID.b, revision: "B", previousRevisionId: ID.a, supersededById: ID.c }),
      bom({ id: ID.c, revision: "C", previousRevisionId: ID.b }),
    ];
    const { body } = await call(ID.c);
    expect(body.map((r: { revision: string }) => r.revision)).toEqual(["B", "C"]);
  });

  it("returns a single entry for a BOM that was never revised", async () => {
    rows.boms = [bom({ id: ID.a, revision: "A" })];
    const { body } = await call(ID.a);
    expect(body).toHaveLength(1);
    expect(body[0].isCurrent).toBe(true);
  });

  it("404s for a BOM that does not exist", async () => {
    rows.boms = [];
    const { status } = await call(ID.a);
    expect(status).toBe(404);
  });
});

describe("ordering does not depend on timestamps", () => {
  it("orders by the links even when every createdAt is identical", async () => {
    // A bulk import writes many rows in the same millisecond. Sorting by
    // createdAt ordered those arbitrarily, which is the one thing a revision
    // history must never do — this is why the walk order is preserved.
    const same = "2026-01-01T00:00:00.000Z";
    rows.boms = [
      bom({ id: ID.c, revision: "C", previousRevisionId: ID.b, createdAt: same }),
      bom({ id: ID.a, revision: "A", supersededById: ID.b, createdAt: same }),
      bom({
        id: ID.b,
        revision: "B",
        previousRevisionId: ID.a,
        supersededById: ID.c,
        createdAt: same,
      }),
    ];
    const { body } = await call(ID.c);
    expect(body.map((r: { revision: string }) => r.revision)).toEqual(["A", "B", "C"]);
  });
});
