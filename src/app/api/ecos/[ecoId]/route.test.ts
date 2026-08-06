import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Deciding an ECO is separated from editing one.
 *
 * ECO_APPROVE existed in PERMISSION_INFO, was granted to Admin and Manager in
 * DEFAULT_ROLES, and was asserted in permissions.test.ts — while no route ever
 * read it. Combined with `findWorkflowForTrigger` falling through to a direct
 * status update when no workflow is assigned (and no tenant being seeded with
 * an ECO workflow), one Engineer could walk an ECO to APPROVED alone and then
 * implement it, releasing parts, files and BOM revisions.
 *
 * These are the tests that make the permission load-bearing, so it cannot
 * quietly go dead again.
 *
 * The Supabase mock honours `.eq()` filters — see the note in
 * files/[fileId]/checkout/route.test.ts for why that matters.
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
    email: string;
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
// No workflow assigned — the fall-through path that made this reachable.
vi.mock("@/lib/approval-engine", () => ({
  findWorkflowForTrigger: vi.fn().mockResolvedValue(null),
  startWorkflow: vi.fn().mockResolvedValue({ success: true }),
}));

import { PUT } from "./route";

const ECO_ID = "33333333-3333-4333-8333-333333333333";
const params = Promise.resolve({ ecoId: ECO_ID });

function req(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/ecos/${ECO_ID}`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const engineer = {
  id: "user-1",
  tenantId: "tenant-1",
  fullName: "Alice",
  email: "alice@example.com",
  role: { permissions: ["eco.create", "eco.edit"] },
};

const manager = {
  id: "user-2",
  tenantId: "tenant-1",
  fullName: "Bob",
  email: "bob@example.com",
  role: { permissions: ["eco.create", "eco.edit", "eco.approve"] },
};

const inReviewEco = {
  id: ECO_ID,
  tenantId: "tenant-1",
  ecoNumber: "ECO-001",
  title: "Bracket change",
  status: "IN_REVIEW",
  createdById: "user-1",
  deletedAt: null,
};

beforeEach(() => {
  for (const k of Object.keys(tableResults)) delete tableResults[k];
  tableResults.ecos = { data: inReviewEco, error: null };
  mockTenantUser.current = null;
});

describe("ECO decision transitions require ECO_APPROVE", () => {
  it("refuses APPROVED from a user with only eco.edit", async () => {
    mockTenantUser.current = engineer;
    const res = await PUT(req({ status: "APPROVED" }), { params });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("Approve ECOs") });
  });

  it("refuses REJECTED from a user with only eco.edit", async () => {
    mockTenantUser.current = engineer;
    const res = await PUT(req({ status: "REJECTED" }), { params });
    expect(res.status).toBe(403);
  });

  it("allows APPROVED for a user holding eco.approve", async () => {
    mockTenantUser.current = manager;
    const res = await PUT(req({ status: "APPROVED" }), { params });
    expect(res.status).not.toBe(403);
  });

  it("still allows a non-decision transition with only eco.edit", async () => {
    // SUBMITTED → IN_REVIEW is triage, not a verdict. Gating it too would
    // stop an author moving their own ECO along, which is not the point.
    mockTenantUser.current = engineer;
    tableResults.ecos = { data: { ...inReviewEco, status: "SUBMITTED" }, error: null };
    const res = await PUT(req({ status: "IN_REVIEW" }), { params });
    expect(res.status).not.toBe(403);
  });

  it("rejects an invalid transition before checking the permission", async () => {
    // A bad transition is a 400 whoever asks, so the error names the real
    // problem rather than sending someone off to find an approver.
    mockTenantUser.current = engineer;
    tableResults.ecos = { data: { ...inReviewEco, status: "DRAFT" }, error: null };
    const res = await PUT(req({ status: "APPROVED" }), { params });
    expect(res.status).toBe(400);
  });
});

/**
 * Self-approval on the direct status path.
 *
 * This is the path that matters. `findWorkflowForTrigger` falls through to a
 * direct status update when no workflow is assigned, and no tenant is seeded
 * with an ECO workflow — so for most tenants an ECO is decided here and never
 * touches the approval engine. Gating only the engine would leave the setting
 * looking enforced while doing nothing on the path everyone uses, which is
 * finding 2 of the functional audit repeated exactly.
 */
describe("self-approval on the direct ECO status path", () => {
  /** An approver who also authored the ECO. */
  const authorApprover = {
    id: "user-1", // matches inReviewEco.createdById
    tenantId: "tenant-1",
    fullName: "Alice",
    email: "alice@example.com",
    role: { permissions: ["eco.create", "eco.edit", "eco.approve"] },
  };

  function givenSetting(blockSelfApproval: boolean) {
    tableResults.tenants = { data: { settings: { blockSelfApproval } }, error: null };
  }

  it("lets an author approve their own ECO by default", async () => {
    mockTenantUser.current = authorApprover;
    tableResults.tenants = { data: { settings: {} }, error: null };
    expect((await PUT(req({ status: "APPROVED" }), { params })).status).not.toBe(403);
  });

  it("refuses when the tenant has turned self-approval off", async () => {
    mockTenantUser.current = authorApprover;
    givenSetting(true);
    const res = await PUT(req({ status: "APPROVED" }), { params });
    expect(res.status).toBe(403);
    const { error } = await res.json();
    expect(error).toMatch(/raised this request/i);
    expect(error).toMatch(/Block self-approval/);
  });

  it("refuses a self-rejection on the same terms", async () => {
    mockTenantUser.current = authorApprover;
    givenSetting(true);
    expect((await PUT(req({ status: "REJECTED" }), { params })).status).toBe(403);
  });

  it("still lets a different approver decide it", async () => {
    mockTenantUser.current = manager; // user-2, not the author
    givenSetting(true);
    expect((await PUT(req({ status: "APPROVED" }), { params })).status).not.toBe(403);
  });

  /**
   * The setting governs deciding, not moving an ECO along. An author must
   * still be able to submit their own change order for review — that is the
   * normal way one starts.
   */
  it("does not block the author submitting their own ECO", async () => {
    mockTenantUser.current = authorApprover;
    givenSetting(true);
    tableResults.ecos = { data: { ...inReviewEco, status: "DRAFT" }, error: null };
    expect((await PUT(req({ status: "SUBMITTED" }), { params })).status).not.toBe(403);
  });

  /**
   * The permission is the more fundamental refusal and must win, or an
   * engineer without eco.approve would be told about a policy setting rather
   * than that they cannot approve at all.
   */
  it("reports the missing permission ahead of self-approval", async () => {
    mockTenantUser.current = engineer; // authored it, but has no eco.approve
    givenSetting(true);
    const res = await PUT(req({ status: "APPROVED" }), { params });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Approve ECOs/);
  });

  it("permits the decision when the settings read fails", async () => {
    // Fails open: this is a process preference, not a security control.
    mockTenantUser.current = authorApprover;
    tableResults.tenants = { data: null, error: { message: "timeout" } };
    expect((await PUT(req({ status: "APPROVED" }), { params })).status).not.toBe(403);
  });
});
