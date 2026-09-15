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

const { tableResults, updateCalls, mockFrom } = vi.hoisted(() => {
  type QueryResult = { data: unknown; error: unknown };
  type Handler = QueryResult | ((filters: Record<string, unknown>) => QueryResult);
  const tableResults: Record<string, Handler> = {};
  const updateCalls: Array<{ table: string; data: unknown; filters: Record<string, unknown> }> = [];

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
    chain.update = (data: unknown) => {
      const entry = { table, data, filters: {} as Record<string, unknown> };
      updateCalls.push(entry);
      const u: Record<string, (...a: unknown[]) => unknown> = {};
      u.eq = (...a: unknown[]) => {
        entry.filters[a[0] as string] = a[1];
        return u;
      };
      u.select = () => u;
      u.single = () => resolvable();
      u.then = ((resolve: (v: unknown) => void) =>
        resolve({ data: null, error: null })) as unknown as (...a: unknown[]) => unknown;
      return u;
    };
    chain.then = ((resolve: (v: unknown) => void) => resolve(resolvable())) as unknown as (
      ...args: unknown[]
    ) => unknown;
    return chain;
  }

  return { tableResults, updateCalls, mockFrom: (table: string) => makeChain(table) };
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
vi.mock("@/lib/eco-release-check", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/eco-release-check")>("@/lib/eco-release-check");
  return {
    ...actual,
    checkEcoRelease: vi.fn().mockResolvedValue({ blockers: [], filesToRelease: [] }),
  };
});
// No workflow assigned — the fall-through path that made this reachable.
vi.mock("@/lib/approval-engine", () => ({
  findWorkflowForTrigger: vi.fn().mockResolvedValue(null),
  findEcoApprovalWorkflow: vi.fn().mockResolvedValue(null),
  startWorkflow: vi.fn().mockResolvedValue({ success: true }),
}));

import { PUT } from "./route";
import {
  findEcoApprovalWorkflow,
  findWorkflowForTrigger,
  startWorkflow,
} from "@/lib/approval-engine";
import { logAudit } from "@/lib/audit";
import { notify } from "@/lib/notifications";
import { checkEcoRelease } from "@/lib/eco-release-check";
import { fromDateInputValue } from "@/app/(dashboard)/ecos/effectivity";

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
  vi.clearAllMocks();
  for (const k of Object.keys(tableResults)) delete tableResults[k];
  updateCalls.length = 0;
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

  it("links the creator's notification to the ECO, not the list", async () => {
    // Every ECO notification used to link to /ecos, so clicking one landed on
    // the whole list and left the reader to find which change it was about.
    mockTenantUser.current = manager;
    await PUT(req({ status: "APPROVED" }), { params });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ userIds: ["user-1"], link: `/ecos/${ECO_ID}` })
    );
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

/**
 * While a workflow's approval request is out, that request is the decision.
 *
 * With a workflow on SUBMITTED, anyone with eco.edit could move the ECO to
 * IN_REVIEW and a Manager could approve or reject it directly, all with the
 * request still pending — its eventual outcome then landed on top of whatever
 * the ECO had become. And startWorkflow's one-pending-request-per-entity guard
 * handed a resubmitted ECO its stale old request.
 */
describe("direct status changes while an approval request is pending", () => {
  function givenPendingRequest() {
    tableResults.approval_requests = (filters) =>
      filters.entityType === "eco" && filters.entityId === ECO_ID && filters.status === "PENDING"
        ? { data: [{ id: "req-1" }], error: null }
        : { data: [], error: null };
  }

  it("refuses moving a submitted ECO into review", async () => {
    mockTenantUser.current = engineer;
    tableResults.ecos = { data: { ...inReviewEco, status: "SUBMITTED" }, error: null };
    givenPendingRequest();

    const res = await PUT(req({ status: "IN_REVIEW" }), { params });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/approval request in progress.*Approvals page/);
    expect(updateCalls).toHaveLength(0);
  });

  it("refuses a Manager approving it directly", async () => {
    mockTenantUser.current = manager;
    givenPendingRequest();

    const res = await PUT(req({ status: "APPROVED" }), { params });

    expect(res.status).toBe(409);
    expect(updateCalls).toHaveLength(0);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("refuses a direct rejection too", async () => {
    mockTenantUser.current = manager;
    givenPendingRequest();
    expect((await PUT(req({ status: "REJECTED" }), { params })).status).toBe(409);
  });

  it("still allows the change once no request is pending", async () => {
    mockTenantUser.current = manager;
    tableResults.approval_requests = { data: [], error: null };
    const res = await PUT(req({ status: "APPROVED" }), { params });
    expect(res.status).toBe(200);
    expect(updateCalls[0].data).toMatchObject({ status: "APPROVED" });
  });
});

/**
 * A workflow that cannot start used to return 200 with the ECO already moved
 * to SUBMITTED and no request behind it, so it waited on an approval that did
 * not exist and nothing said so.
 */
/**
 * AUD-003 CHG-1. Once a request was recalled or sent back for rework, an ECO
 * sat in SUBMITTED or IN_REVIEW with nothing pending, and a Manager could
 * approve it here while the tenant's workflow never ran.
 */
/**
 * Submitting locks an ECO's files, so anything that would stop implement
 * releasing them has to be fixed before it is submitted (AUD-003 CHG-2).
 */
describe("submitting an ECO whose files implement could not release", () => {
  it("refuses, naming each problem, before any workflow starts", async () => {
    mockTenantUser.current = engineer;
    tableResults.ecos = { data: { ...inReviewEco, status: "DRAFT" }, error: null };
    vi.mocked(checkEcoRelease).mockResolvedValueOnce({
      blockers: ["bracket.SLDDRW is checked out by Bob. Check it in first."],
      filesToRelease: [],
    });

    const res = await PUT(req({ status: "SUBMITTED" }), { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/ECO-001 cannot be submitted yet: bracket.SLDDRW is checked out/);
    expect(body.details.blockers).toHaveLength(1);
    expect(checkEcoRelease).toHaveBeenCalledWith("tenant-1", ECO_ID, "submit");
    expect(findWorkflowForTrigger).not.toHaveBeenCalled();
    expect(updateCalls.filter((c) => c.table === "ecos")).toHaveLength(0);
  });

  it("submits when nothing blocks", async () => {
    mockTenantUser.current = engineer;
    tableResults.ecos = { data: { ...inReviewEco, status: "DRAFT" }, error: null };
    const res = await PUT(req({ status: "SUBMITTED" }), { params });
    expect(res.status).toBe(200);
  });
});

describe("direct approval while a workflow governs ECO approvals", () => {
  beforeEach(() => {
    vi.mocked(findEcoApprovalWorkflow).mockResolvedValue({ id: "wf-1", name: "ECO Board" });
  });

  it("refuses a Manager approving an ECO directly", async () => {
    mockTenantUser.current = manager;

    const res = await PUT(req({ status: "APPROVED" }), { params });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/go through the "ECO Board" workflow/);
    expect(updateCalls.filter((c) => c.table === "ecos")).toHaveLength(0);
  });

  it("still allows a direct rejection, which releases nothing", async () => {
    mockTenantUser.current = manager;
    const res = await PUT(req({ status: "REJECTED" }), { params });
    expect(res.status).toBe(200);
  });

  it("refuses rather than allows when the workflow lookup fails", async () => {
    mockTenantUser.current = manager;
    vi.mocked(findEcoApprovalWorkflow).mockRejectedValue(new Error("connection reset"));

    const res = await PUT(req({ status: "APPROVED" }), { params });

    expect(res.status).toBe(500);
    expect(updateCalls.filter((c) => c.table === "ecos")).toHaveLength(0);
  });

  it("still allows a direct approval for a tenant with no ECO workflow", async () => {
    vi.mocked(findEcoApprovalWorkflow).mockResolvedValue(null);
    mockTenantUser.current = manager;
    const res = await PUT(req({ status: "APPROVED" }), { params });
    expect(res.status).toBe(200);
  });
});

describe("submitting into a workflow that cannot start", () => {
  it("puts the ECO back and surfaces the reason", async () => {
    mockTenantUser.current = engineer;
    tableResults.ecos = { data: { ...inReviewEco, status: "DRAFT" }, error: null };
    vi.mocked(findWorkflowForTrigger).mockResolvedValueOnce({
      id: "wf-1",
      name: "ECO review",
      isActive: true,
    });
    vi.mocked(startWorkflow).mockResolvedValueOnce({
      success: false,
      error: "Workflow has no steps",
    } as Awaited<ReturnType<typeof startWorkflow>>);

    const res = await PUT(req({ status: "SUBMITTED" }), { params });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/stays in DRAFT.*Workflow has no steps/);
    expect(updateCalls.map((u) => u.data)).toMatchObject([
      { status: "SUBMITTED" },
      { status: "DRAFT" },
    ]);
    // The revert only undoes our own move, not a change that landed since.
    expect(updateCalls[1].filters).toMatchObject({ id: ECO_ID, status: "SUBMITTED" });
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("reports a started workflow as pending approval", async () => {
    mockTenantUser.current = engineer;
    tableResults.ecos = { data: { ...inReviewEco, status: "DRAFT" }, error: null };
    vi.mocked(findWorkflowForTrigger).mockResolvedValueOnce({
      id: "wf-1",
      name: "ECO review",
      isActive: true,
    });
    vi.mocked(startWorkflow).mockResolvedValueOnce({
      success: true,
      requestId: "req-1",
      pendingApproval: true,
      message: "Approval workflow started",
    } as Awaited<ReturnType<typeof startWorkflow>>);

    const res = await PUT(req({ status: "SUBMITTED" }), { params });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pendingApproval: true });
    expect(updateCalls).toHaveLength(1);
  });
});

/**
 * Typed effectivity. The schema accepted `effectivityType`, `effectiveFrom`
 * and `effectiveSerial` and the handler never wrote them, so the form said
 * "ECO updated" and the choice was gone on refresh.
 */
describe("typed effectivity", () => {
  const draftEco = {
    ...inReviewEco,
    status: "DRAFT",
    effectivityType: null,
    effectiveFrom: null,
    effectiveSerial: null,
  };

  function saved() {
    return updateCalls.find((u) => u.table === "ecos")?.data as Record<string, unknown>;
  }

  beforeEach(() => {
    mockTenantUser.current = engineer;
    tableResults.ecos = { data: draftEco, error: null };
  });

  /** Built with the form's own converter, so the two cannot drift apart. */
  it("saves a date exactly as the ECO form sends it", async () => {
    const effectiveFrom = fromDateInputValue("2026-10-01");

    const res = await PUT(req({ effectivityType: "DATE", effectiveFrom, effectiveSerial: null }), {
      params,
    });

    expect(res.status).toBe(200);
    expect(saved()).toMatchObject({
      effectivityType: "DATE",
      effectiveFrom: "2026-10-01T00:00:00.000Z",
      effectiveSerial: null,
    });
  });

  it("saves a starting serial", async () => {
    await PUT(req({ effectivityType: "SERIAL", effectiveSerial: "SN-500" }), { params });
    expect(saved()).toMatchObject({
      effectivityType: "SERIAL",
      effectiveSerial: "SN-500",
      effectiveFrom: null,
    });
  });

  it("saves use-up effectivity", async () => {
    await PUT(req({ effectivityType: "USE_UP" }), { params });
    expect(saved()).toMatchObject({ effectivityType: "USE_UP" });
  });

  it("clears the date when the type moves off DATE", async () => {
    tableResults.ecos = {
      data: { ...draftEco, effectivityType: "DATE", effectiveFrom: "2026-10-01T00:00:00.000Z" },
      error: null,
    };
    await PUT(req({ effectivityType: "IMMEDIATE" }), { params });
    expect(saved()).toMatchObject({ effectivityType: "IMMEDIATE", effectiveFrom: null });
  });

  it("clears the serial when the type moves off SERIAL", async () => {
    tableResults.ecos = {
      data: { ...draftEco, effectivityType: "SERIAL", effectiveSerial: "SN-500" },
      error: null,
    };
    await PUT(req({ effectivityType: "DATE", effectiveFrom: "2026-10-01T00:00:00.000Z" }), {
      params,
    });
    expect(saved()).toMatchObject({ effectiveSerial: null });
  });

  it("keeps the stored date when the body only restates the type", async () => {
    tableResults.ecos = {
      data: { ...draftEco, effectivityType: "DATE", effectiveFrom: "2026-10-01T00:00:00.000Z" },
      error: null,
    };
    await PUT(req({ effectivityType: "DATE" }), { params });
    expect(saved()).toMatchObject({ effectiveFrom: "2026-10-01T00:00:00.000Z" });
  });

  it("refuses date effectivity with no date sent or stored", async () => {
    const res = await PUT(req({ effectivityType: "DATE" }), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/needs a date/);
    expect(updateCalls).toHaveLength(0);
  });

  it("refuses a date sent for a type that does not use one", async () => {
    const res = await PUT(
      req({ effectivityType: "IMMEDIATE", effectiveFrom: "2026-10-01T00:00:00.000Z" }),
      { params }
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/only applies to date effectivity/);
    expect(updateCalls).toHaveLength(0);
  });

  it("is refused once the ECO has left DRAFT, like every other field", async () => {
    tableResults.ecos = { data: { ...draftEco, status: "SUBMITTED" }, error: null };
    const res = await PUT(req({ effectivityType: "IMMEDIATE" }), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/only edit fields when ECO is in DRAFT/);
    expect(updateCalls).toHaveLength(0);
  });
});
