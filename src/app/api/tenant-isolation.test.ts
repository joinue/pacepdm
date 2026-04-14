/**
 * Multi-tenancy isolation tests for critical API routes.
 *
 * These tests do NOT hit a real database. They mock the Supabase client and
 * `getApiTenantUser` so we can simulate "user from tenant A holds an ID that
 * belongs to tenant B" scenarios and assert that the route handler refuses
 * to leak or mutate the cross-tenant resource.
 *
 * Two distinct guard styles are tested:
 *
 *   1. SQL-level guard — the query itself includes `.eq("tenantId", ...)`,
 *      so a cross-tenant row is never returned at all. The mock honors the
 *      filter and returns null when the tenant doesn't match. (e.g. GET ECO)
 *
 *   2. Application-level guard — the query fetches by id only, then the
 *      handler checks `row.tenantId === tenantUser.tenantId` in JS before
 *      proceeding. The mock returns the cross-tenant row, and we verify the
 *      handler still rejects. (e.g. GET file detail, PUT/DELETE ECO)
 *
 * If a future refactor accidentally drops either guard, these tests fail.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock state so vi.mock factories can reach it ────────────────────

const { mockTenantUser, supabaseResponses, mockSupabaseFrom } = vi.hoisted(() => {
  type QueryResult = { data: unknown; error: unknown };
  type ResponseHandler = QueryResult | ((filters: Record<string, unknown>) => QueryResult);

  const mockTenantUser: { current: unknown } = { current: null };
  const supabaseResponses = new Map<string, ResponseHandler>();

  function resolveFor(table: string, filters: Record<string, unknown>): QueryResult {
    const handler = supabaseResponses.get(table);
    if (typeof handler === "function") return handler(filters);
    if (handler) return handler;
    return { data: null, error: null };
  }

  function makeChain(table: string) {
    const filters: Record<string, unknown> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {};

    for (const m of ["select", "eq", "in", "neq", "is", "order", "limit", "match"] as const) {
      chain[m] = (...args: unknown[]) => {
        if (m === "eq" && args.length === 2) filters[args[0] as string] = args[1];
        return chain;
      };
    }

    chain.single = () => Promise.resolve(resolveFor(table, filters));
    // Supabase's maybeSingle() is equivalent to single() for our mock —
    // both call sites in the tests register a single row or a null, so
    // the only difference (error-vs-null on zero rows) doesn't matter.
    chain.maybeSingle = () => Promise.resolve(resolveFor(table, filters));

    // For chains awaited directly (no .single()), default to an empty list
    // unless the test registered a list-shaped response.
    chain.then = (resolve: (v: unknown) => void) => {
      const result = resolveFor(table, filters);
      // If no explicit handler, prefer an empty array for list queries
      if (!supabaseResponses.has(table) && result.data === null) {
        resolve({ data: [], error: null });
      } else {
        resolve(result);
      }
    };

    chain.update = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updateChain: any = {};
      updateChain.eq = () => updateChain;
      updateChain.select = () => updateChain;
      updateChain.single = () => Promise.resolve({ data: { id: "updated" }, error: null });
      updateChain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
      return updateChain;
    };

    chain.delete = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const delChain: any = {};
      delChain.eq = () => delChain;
      delChain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
      return delChain;
    };

    chain.insert = () => ({
      select: () => ({ single: () => Promise.resolve({ data: null, error: null }) }),
      then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
    });

    return chain;
  }

  const mockSupabaseFrom = (table: string) => makeChain(table);

  return { mockTenantUser, supabaseResponses, mockSupabaseFrom };
});

vi.mock("@/lib/db", () => ({
  getServiceClient: () => ({
    from: mockSupabaseFrom,
    storage: {
      from: () => ({
        createSignedUrl: () => Promise.resolve({ data: null }),
      }),
    },
    // get_folder_access_scope is called by routes that run through the
    // folder-access resolver. Returning an "open" scope (no restrictions)
    // keeps this mock transparent for tenant-isolation tests, which are
    // concerned with cross-tenant leaks, not ACL rows.
    rpc: () => Promise.resolve({
      data: {
        bypass: false,
        restrictedAny: false,
        allowed: [],
        editable: [],
        admin: [],
        denied: [],
        restricted: [],
      },
      error: null,
    }),
  }),
}));

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    getApiTenantUser: vi.fn(() => Promise.resolve(mockTenantUser.current)),
  };
});

vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@/lib/notifications", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
  notifyApprovalGroupMembers: vi.fn().mockResolvedValue(undefined),
  sideEffect: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/mentions", () => ({
  processMentions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/approval-engine", () => ({
  startWorkflow: vi.fn().mockResolvedValue({ success: true }),
  findWorkflowForTrigger: vi.fn().mockResolvedValue(null),
  processDecision: vi.fn().mockResolvedValue({ success: true }),
  rejectForRework: vi.fn().mockResolvedValue({ success: true }),
}));

// ── Imports under test (must come after vi.mock calls) ─────────────────────

import { GET as getFileDetail } from "@/app/api/files/[fileId]/route";
import { GET as listFiles } from "@/app/api/files/route";
import { GET as getEco, PUT as putEco, DELETE as deleteEco } from "@/app/api/ecos/[ecoId]/route";

// ── Fixtures ────────────────────────────────────────────────────────────────

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

const userInTenantA = {
  id: "user-a",
  tenantId: TENANT_A,
  fullName: "Alice From A",
  authUserId: "auth-a",
  email: "alice@a.test",
  role: { id: "role-a", name: "Admin", permissions: ["*"] },
};

function makeRequest(url = "http://test.local/api/x"): Request {
  return new Request(url);
}

beforeEach(() => {
  mockTenantUser.current = userInTenantA;
  supabaseResponses.clear();
  vi.clearAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Multi-tenant isolation (API routes)", () => {
  describe("GET /api/files/[fileId] — application-level tenant guard", () => {
    it("returns 404 when the requested file belongs to a different tenant", async () => {
      // Simulate Supabase returning the row even though it's another tenant's
      // (the query is by id only — no SQL tenant filter on this route).
      supabaseResponses.set("files", {
        data: { id: "file-1", tenantId: TENANT_B, name: "secret.sldprt", currentVersion: 1 },
        error: null,
      });

      const res = await getFileDetail(makeRequest() as never, {
        params: Promise.resolve({ fileId: "file-1" }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toEqual({ error: "File not found" });
    });

    it("returns the file when it belongs to the caller's tenant", async () => {
      supabaseResponses.set("files", {
        data: { id: "file-1", tenantId: TENANT_A, name: "ours.sldprt", currentVersion: 1 },
        error: null,
      });

      const res = await getFileDetail(makeRequest() as never, {
        params: Promise.resolve({ fileId: "file-1" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("file-1");
      expect(body.tenantId).toBe(TENANT_A);
    });

    it("returns 401 when no tenant user is authenticated", async () => {
      mockTenantUser.current = null;
      const res = await getFileDetail(makeRequest() as never, {
        params: Promise.resolve({ fileId: "file-1" }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/ecos/[ecoId] — SQL-level tenant guard", () => {
    it("returns 404 when an ECO ID exists but belongs to another tenant", async () => {
      // The SQL query includes .eq("tenantId", caller). Honor that — return
      // the row only when the asked tenant matches TENANT_B (where it lives).
      supabaseResponses.set("ecos", (filters) =>
        filters.tenantId === TENANT_B
          ? { data: { id: "eco-1", tenantId: TENANT_B }, error: null }
          : { data: null, error: null },
      );

      const res = await getEco(makeRequest() as never, {
        params: Promise.resolve({ ecoId: "eco-1" }),
      });

      // Caller is in tenant A → SQL filter excludes the tenant-B row → 404
      expect(res.status).toBe(404);
    });

    it("returns the ECO when it belongs to the caller's tenant", async () => {
      supabaseResponses.set("ecos", (filters) =>
        filters.tenantId === TENANT_A
          ? { data: { id: "eco-1", tenantId: TENANT_A, ecoNumber: "ECO-1" }, error: null }
          : { data: null, error: null },
      );

      const res = await getEco(makeRequest() as never, {
        params: Promise.resolve({ ecoId: "eco-1" }),
      });

      expect(res.status).toBe(200);
    });
  });

  describe("PUT /api/ecos/[ecoId] — application-level tenant guard", () => {
    it("returns 404 when updating an ECO from another tenant", async () => {
      // PUT fetches by id only (no tenant filter), then guards in JS.
      supabaseResponses.set("ecos", {
        data: { id: "eco-1", tenantId: TENANT_B, status: "DRAFT", ecoNumber: "ECO-001", createdById: "user-b" },
        error: null,
      });

      const req = new Request("http://test.local/api/ecos/eco-1", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Hijacked title" }),
      });

      const res = await putEco(req as never, {
        params: Promise.resolve({ ecoId: "eco-1" }),
      });

      expect(res.status).toBe(404);
    });

    it("returns 401 when no tenant user is authenticated", async () => {
      mockTenantUser.current = null;
      const req = new Request("http://test.local/api/ecos/eco-1", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      });
      const res = await putEco(req as never, {
        params: Promise.resolve({ ecoId: "eco-1" }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("DELETE /api/ecos/[ecoId] — application-level tenant guard", () => {
    it("returns 404 when deleting an ECO from another tenant", async () => {
      supabaseResponses.set("ecos", {
        data: { id: "eco-1", tenantId: TENANT_B, status: "DRAFT", ecoNumber: "ECO-001" },
        error: null,
      });

      const res = await deleteEco(makeRequest() as never, {
        params: Promise.resolve({ ecoId: "eco-1" }),
      });

      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/files (list) — SQL-level tenant guard", () => {
    it("scopes the file listing query to the caller's tenant", async () => {
      let observedTenantFilter: unknown = "<unset>";
      supabaseResponses.set("files", (filters) => {
        observedTenantFilter = filters.tenantId;
        return { data: [], error: null };
      });

      const req = new Request("http://test.local/api/files?folderId=folder-1");
      const res = await listFiles(req as never);

      expect(res.status).toBe(200);
      // The route MUST have applied .eq("tenantId", tenantUser.tenantId).
      // If a refactor drops it, this assertion fails — and tenant data leaks.
      expect(observedTenantFilter).toBe(TENANT_A);
    });

    it("returns 401 when no tenant user is authenticated", async () => {
      mockTenantUser.current = null;
      const req = new Request("http://test.local/api/files?folderId=folder-1");
      const res = await listFiles(req as never);
      expect(res.status).toBe(401);
    });
  });
});
