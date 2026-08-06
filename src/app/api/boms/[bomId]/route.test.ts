import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Releasing a BOM is a decision, not an edit.
 *
 * Before this, DRAFT → IN_REVIEW → APPROVED → RELEASED was three PUTs from
 * anyone holding `file.edit`, with no approval and no second person, so the
 * two middle states meant nothing. In the same tenant a drawing could not
 * reach Released without a workflow and a member of the Approvers group —
 * the bill of materials that drives purchasing needed less than the drawing.
 *
 * The `implement_eco` path deliberately does not go through this route: an
 * ECO carrying a BOM releases it in SQL, and that is gated by the ECO
 * reaching APPROVED, which now requires the same permission.
 */

const { tableResults, mockFrom } = vi.hoisted(() => {
  type QueryResult = { data: unknown; error: unknown };
  type Handler = QueryResult | ((filters: Record<string, unknown>) => QueryResult);
  const tableResults: Record<string, Handler> = {};

  function makeChain(table: string) {
    const filters: Record<string, unknown> = {};
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    const resolvable = (): QueryResult => {
      const handler = tableResults[table];
      if (typeof handler === "function") return handler(filters);
      return handler ?? { data: null, error: null };
    };
    for (const m of ["select", "eq", "in", "neq", "is", "order", "limit", "match"] as const) {
      chain[m] = (...args: unknown[]) => {
        if (m === "eq" && args.length === 2) filters[args[0] as string] = args[1];
        return chain;
      };
    }
    chain.single = () => resolvable();
    chain.maybeSingle = () => resolvable();
    chain.update = () => {
      const u: Record<string, (...a: unknown[]) => unknown> = {};
      for (const m of ["eq", "select"] as const) u[m] = () => u;
      u.single = () => resolvable();
      return u;
    };
    chain.then = ((resolve: (v: unknown) => void) => resolve(resolvable())) as unknown as (
      ...args: unknown[]
    ) => unknown;
    return chain;
  }

  return { tableResults, mockFrom: (table: string) => makeChain(table) };
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
vi.mock("@/lib/notifications", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
  sideEffect: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/bom-snapshot", () => ({
  captureBomSnapshot: vi
    .fn()
    .mockResolvedValue({ snapshotId: "s1", itemCount: 0, flatTotalCost: 0 }),
}));

import { PUT } from "./route";

const BOM_ID = "44444444-4444-4444-8444-444444444444";
const params = Promise.resolve({ bomId: BOM_ID });

function req(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/boms/${BOM_ID}`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const engineer = {
  id: "user-1",
  tenantId: "tenant-1",
  fullName: "Alice",
  role: { permissions: ["file.edit", "file.transition"] },
};

const manager = {
  id: "user-2",
  tenantId: "tenant-1",
  fullName: "Bob",
  role: { permissions: ["file.edit", "file.transition", "eco.approve"] },
};

const approvedBom = {
  id: BOM_ID,
  status: "APPROVED",
  name: "NANO-1000S",
  createdById: "user-1",
  previousRevisionId: null,
};

beforeEach(() => {
  for (const k of Object.keys(tableResults)) delete tableResults[k];
  tableResults.boms = { data: approvedBom, error: null };
  mockTenantUser.current = null;
});

describe("BOM release requires ECO_APPROVE", () => {
  it("refuses RELEASED from a user with only file.edit", async () => {
    mockTenantUser.current = engineer;
    const res = await PUT(req({ status: "RELEASED" }), { params });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("Approve ECOs") });
  });

  it("refuses OBSOLETE from a user with only file.edit", async () => {
    mockTenantUser.current = engineer;
    tableResults.boms = { data: { ...approvedBom, status: "RELEASED" }, error: null };
    const res = await PUT(req({ status: "OBSOLETE" }), { params });
    expect(res.status).toBe(403);
  });

  it("allows RELEASED for a user holding eco.approve", async () => {
    mockTenantUser.current = manager;
    const res = await PUT(req({ status: "RELEASED" }), { params });
    expect(res.status).not.toBe(403);
  });

  it("still allows DRAFT → IN_REVIEW with only file.edit", async () => {
    // Moving a BOM towards review is ordinary engineering work. Gating it
    // would mean an engineer could not put their own structure up for
    // approval, which is not what this protects.
    mockTenantUser.current = engineer;
    tableResults.boms = { data: { ...approvedBom, status: "DRAFT" }, error: null };
    const res = await PUT(req({ status: "IN_REVIEW" }), { params });
    expect(res.status).not.toBe(403);
  });

  it("still allows a rename with only file.edit", async () => {
    mockTenantUser.current = engineer;
    const res = await PUT(req({ name: "NANO-1000S rev C" }), { params });
    expect(res.status).not.toBe(403);
  });

  it("rejects an illegal transition before checking the permission", async () => {
    mockTenantUser.current = engineer;
    tableResults.boms = { data: { ...approvedBom, status: "DRAFT" }, error: null };
    const res = await PUT(req({ status: "RELEASED" }), { params });
    expect(res.status).toBe(400);
  });
});

/**
 * A line with no `partId` and no `linkedBomId` is free text. That is fine
 * while drafting and useless afterwards: it cannot map to an ERP item, cannot
 * be found by where-used, and rolls up no cost. The gate is on the transition
 * so the error reaches whoever typed the line rather than whoever runs the
 * integration months later.
 */
describe("leaving DRAFT requires every line to resolve", () => {
  const draftBom = { ...approvedBom, status: "DRAFT" };

  beforeEach(() => {
    mockTenantUser.current = engineer;
    tableResults.boms = { data: draftBom, error: null };
  });

  it("refuses DRAFT → IN_REVIEW while a line is pure free text", async () => {
    tableResults.bom_items = {
      data: [{ itemNumber: "003", name: "M6 washer" }],
      error: null,
    };
    const res = await PUT(req({ status: "IN_REVIEW" }), { params });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    // The message has to name the line, or it is not actionable.
    expect(error).toContain("003 M6 washer");
    expect(error).toMatch(/not linked to a part/i);
  });

  it("allows the transition when every line resolves", async () => {
    tableResults.bom_items = { data: [], error: null };
    const res = await PUT(req({ status: "IN_REVIEW" }), { params });
    expect(res.status).not.toBe(400);
  });

  it("counts a sub-assembly line as resolved", async () => {
    // A sub-assembly carries linkedBomId and no partId. The query filters on
    // both being null, so such a line never reaches the error path — this
    // pins the intent, because requiring partId outright would make every
    // nested assembly unreleasable.
    tableResults.bom_items = { data: [], error: null };
    expect((await PUT(req({ status: "IN_REVIEW" }), { params })).status).not.toBe(400);
  });

  it("names at most five lines, then says how many more", async () => {
    tableResults.bom_items = {
      data: Array.from({ length: 8 }, (_, i) => ({
        itemNumber: `00${i + 1}`,
        name: `Part ${i + 1}`,
      })),
      error: null,
    };
    const { error } = await (await PUT(req({ status: "IN_REVIEW" }), { params })).json();
    expect(error).toContain("001 Part 1");
    expect(error).toContain("005 Part 5");
    expect(error).not.toContain("006 Part 6");
    expect(error).toContain("and 3 more");
  });

  it("handles an unnamed line without rendering 'null'", async () => {
    tableResults.bom_items = { data: [{ itemNumber: null, name: null }], error: null };
    const { error } = await (await PUT(req({ status: "IN_REVIEW" }), { params })).json();
    expect(error).toContain("? (unnamed)");
    expect(error).not.toContain("null");
  });

  /**
   * Coming back the other way has to stay open, or a BOM that acquired a bad
   * line could never be sent back to be fixed — which is the only place it
   * *can* be fixed.
   */
  it("does not gate IN_REVIEW → DRAFT", async () => {
    tableResults.boms = { data: { ...approvedBom, status: "IN_REVIEW" }, error: null };
    tableResults.bom_items = { data: [{ itemNumber: "003", name: "M6 washer" }], error: null };
    expect((await PUT(req({ status: "DRAFT" }), { params })).status).not.toBe(400);
  });

  it("does not gate APPROVED → DRAFT", async () => {
    tableResults.bom_items = { data: [{ itemNumber: "003", name: "M6 washer" }], error: null };
    expect((await PUT(req({ status: "DRAFT" }), { params })).status).not.toBe(400);
  });

  it("does not gate a rename", async () => {
    tableResults.bom_items = { data: [{ itemNumber: "003", name: "M6 washer" }], error: null };
    expect((await PUT(req({ name: "Renamed" }), { params })).status).not.toBe(400);
  });
});

/**
 * `revise` sequences the revision properly; this route used to take any
 * string, so a BOM could be dragged to a value the sequencer would never
 * produce — and the *next* revise would then fail, on a released BOM, with no
 * obvious connection to the edit that caused it.
 */
describe("revision has to stay sequenceable", () => {
  beforeEach(() => {
    mockTenantUser.current = engineer;
    tableResults.boms = { data: approvedBom, error: null };
  });

  // The prefix in the prefixed scheme may contain hyphens, so `A-1` and
  // `Rev-1` sequence to `A-2` and `Rev-2` rather than being rejected.
  it.each(["B", "AA", "2", "09", "R2", "Rev09", "A-1", "Rev-1"])("accepts %s", async (revision) => {
    expect((await PUT(req({ revision }), { params })).status).not.toBe(400);
  });

  it.each(["final", "B (draft)", "1.2", "--", "2A", "A1B"])(
    "refuses %s, which has no successor",
    async (revision) => {
      const res = await PUT(req({ revision }), { params });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/cannot be sequenced|not in a format/i);
    }
  );

  it("refuses an empty revision", async () => {
    expect((await PUT(req({ revision: "   " }), { params })).status).toBe(400);
  });

  /**
   * ASME Y14.35 excludes these because they misread: I and O as 1 and 0, Q as
   * O, S as 5, Z as 2, and X means experimental. The importer tolerates them
   * as a fact about a source system; a value typed here is ours.
   */
  it.each(["I", "O", "Q", "S", "X", "Z"])("refuses reserved letter %s", async (revision) => {
    const res = await PUT(req({ revision }), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Y14.35");
  });

  it("trims before storing, so ' B ' is not a new revision", async () => {
    const res = await PUT(req({ revision: "  B  " }), { params });
    expect(res.status).not.toBe(400);
  });
});
