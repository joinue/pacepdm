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
