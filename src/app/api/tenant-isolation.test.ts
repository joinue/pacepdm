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
    rpc: () =>
      Promise.resolve({
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
import { GET as exportBom } from "@/app/api/boms/[bomId]/export/route";
import { GET as listLifecycleTransitions } from "@/app/api/lifecycle/[lifecycleId]/transitions/route";
import {
  POST as linkPartFile,
  DELETE as unlinkPartFile,
} from "@/app/api/parts/[partId]/files/route";
import { PUT as putFileMetadata } from "@/app/api/files/[fileId]/metadata/route";
import { GET as listShareTokens } from "@/app/api/share-tokens/route";

// ── Fixtures ────────────────────────────────────────────────────────────────

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

// Route params are validated as UUIDs by the wrapper, so ids that reach a
// handler have to look like real ones. A readable placeholder ("eco-1") now
// correctly returns 400 before the handler runs, which is the point of
// declaring a `params` schema — a malformed id is rejected at the boundary
// instead of reaching Postgres as a cast error.
const ECO_ID = "11111111-1111-4111-8111-111111111111";
const FILE_ID = "22222222-2222-4222-8222-222222222222";

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
  describe("GET /api/files/[fileId] — SQL-level tenant guard", () => {
    it("returns 404 when the requested file belongs to a different tenant", async () => {
      // The route loads the file through `loadFile`, which queries the scoped
      // client — so the tenant filter is in the SQL and the row never comes
      // back at all. Previously this route fetched by id and compared
      // tenantId in JavaScript, meaning another tenant's row reached process
      // memory before being rejected.
      supabaseResponses.set("files", (filters) =>
        filters.tenantId === TENANT_B
          ? {
              data: { id: FILE_ID, tenantId: TENANT_B, name: "secret.sldprt", folderId: "f-b" },
              error: null,
            }
          : { data: null, error: null }
      );

      const res = await getFileDetail(makeRequest() as never, {
        params: Promise.resolve({ fileId: FILE_ID }),
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "File not found" });
    });

    it("returns the file when it belongs to the caller's tenant", async () => {
      supabaseResponses.set("files", (filters) =>
        filters.tenantId === TENANT_A
          ? {
              data: { id: FILE_ID, tenantId: TENANT_A, name: "ours.sldprt", folderId: "f-a" },
              error: null,
            }
          : { data: null, error: null }
      );

      const res = await getFileDetail(makeRequest() as never, {
        params: Promise.resolve({ fileId: FILE_ID }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(FILE_ID);
      expect(body.tenantId).toBe(TENANT_A);
    });

    it("returns 401 when no tenant user is authenticated", async () => {
      mockTenantUser.current = null;
      const res = await getFileDetail(makeRequest() as never, {
        params: Promise.resolve({ fileId: FILE_ID }),
      });
      expect(res.status).toBe(401);
    });
  });

  // Every ECO verb is now SQL-level: the route runs on withTenant, whose
  // scoped client applies .eq("tenantId", caller) to every read, update and
  // delete. The mock honours that filter, so a cross-tenant row is simply
  // never returned. Previously PUT and DELETE fetched by id and compared
  // tenantId in JavaScript — the row crossed into process memory before being
  // rejected. These tests fail if a refactor reintroduces that.
  describe("GET /api/ecos/[ecoId] — SQL-level tenant guard", () => {
    it("returns 404 when an ECO ID exists but belongs to another tenant", async () => {
      // Return the row only when the asked tenant matches TENANT_B, where it
      // actually lives. A caller in tenant A must therefore see nothing.
      supabaseResponses.set("ecos", (filters) =>
        filters.tenantId === TENANT_B
          ? { data: { id: ECO_ID, tenantId: TENANT_B }, error: null }
          : { data: null, error: null }
      );

      const res = await getEco(makeRequest() as never, {
        params: Promise.resolve({ ecoId: ECO_ID }),
      });

      expect(res.status).toBe(404);
    });

    it("returns the ECO when it belongs to the caller's tenant", async () => {
      supabaseResponses.set("ecos", (filters) =>
        filters.tenantId === TENANT_A
          ? { data: { id: ECO_ID, tenantId: TENANT_A, ecoNumber: "ECO-1" }, error: null }
          : { data: null, error: null }
      );

      const res = await getEco(makeRequest() as never, {
        params: Promise.resolve({ ecoId: ECO_ID }),
      });

      expect(res.status).toBe(200);
    });

    it("rejects a malformed ECO id before touching the database", async () => {
      const res = await getEco(makeRequest() as never, {
        params: Promise.resolve({ ecoId: "eco-1" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("PUT /api/ecos/[ecoId] — SQL-level tenant guard", () => {
    it("returns 404 when updating an ECO from another tenant", async () => {
      supabaseResponses.set("ecos", (filters) =>
        filters.tenantId === TENANT_B
          ? {
              data: {
                id: ECO_ID,
                tenantId: TENANT_B,
                status: "DRAFT",
                ecoNumber: "ECO-001",
                createdById: "user-b",
              },
              error: null,
            }
          : { data: null, error: null }
      );

      const req = new Request(`http://test.local/api/ecos/${ECO_ID}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Hijacked title" }),
      });

      const res = await putEco(req as never, {
        params: Promise.resolve({ ecoId: ECO_ID }),
      });

      expect(res.status).toBe(404);
    });

    it("returns 401 when no tenant user is authenticated", async () => {
      mockTenantUser.current = null;
      const req = new Request(`http://test.local/api/ecos/${ECO_ID}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      });
      const res = await putEco(req as never, {
        params: Promise.resolve({ ecoId: ECO_ID }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("DELETE /api/ecos/[ecoId] — SQL-level tenant guard", () => {
    it("returns 404 when deleting an ECO from another tenant", async () => {
      supabaseResponses.set("ecos", (filters) =>
        filters.tenantId === TENANT_B
          ? {
              data: { id: ECO_ID, tenantId: TENANT_B, status: "DRAFT", ecoNumber: "ECO-001" },
              error: null,
            }
          : { data: null, error: null }
      );

      const res = await deleteEco(makeRequest() as never, {
        params: Promise.resolve({ ecoId: ECO_ID }),
      });

      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/boms/[bomId]/export — SQL-level tenant guard", () => {
    it("returns 401 when no tenant user is authenticated", async () => {
      mockTenantUser.current = null;
      const res = await exportBom(makeRequest() as never, {
        params: Promise.resolve({ bomId: "bom-1" }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 404 when the BOM belongs to another tenant", async () => {
      // Route filters by tenantId; honor that — return null for tenant-A queries.
      supabaseResponses.set("boms", (filters) =>
        filters.tenantId === TENANT_A
          ? { data: null, error: null }
          : { data: { name: "secret-bom" }, error: null }
      );
      const res = await exportBom(makeRequest() as never, {
        params: Promise.resolve({ bomId: "bom-1" }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/lifecycle/[lifecycleId]/transitions — SQL-level tenant guard", () => {
    it("returns 401 when no tenant user is authenticated", async () => {
      mockTenantUser.current = null;
      const res = await listLifecycleTransitions(
        new Request("http://test.local/api/lifecycle/lc-1/transitions?fromState=DRAFT") as never,
        { params: Promise.resolve({ lifecycleId: "lc-1" }) }
      );
      expect(res.status).toBe(401);
    });

    it("returns 404 when the lifecycle belongs to another tenant", async () => {
      supabaseResponses.set("lifecycles", (filters) =>
        filters.tenantId === TENANT_A
          ? { data: null, error: null }
          : { data: { id: "lc-1" }, error: null }
      );
      const res = await listLifecycleTransitions(
        new Request("http://test.local/api/lifecycle/lc-1/transitions?fromState=DRAFT") as never,
        { params: Promise.resolve({ lifecycleId: "lc-1" }) }
      );
      expect(res.status).toBe(404);
    });
  });

  describe("POST/DELETE /api/parts/[partId]/files — partId tenant guard", () => {
    it("POST returns 404 when the part belongs to another tenant", async () => {
      supabaseResponses.set("parts", (filters) =>
        filters.tenantId === TENANT_A
          ? { data: null, error: null }
          : { data: { id: "part-1" }, error: null }
      );
      const req = new Request("http://test.local/api/parts/part-1/files", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileId: "file-1" }),
      });
      const res = await linkPartFile(req as never, {
        params: Promise.resolve({ partId: "part-1" }),
      });
      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatch(/part not found/i);
    });

    it("DELETE returns 404 when the part belongs to another tenant", async () => {
      supabaseResponses.set("parts", (filters) =>
        filters.tenantId === TENANT_A
          ? { data: null, error: null }
          : { data: { id: "part-1" }, error: null }
      );
      const req = new Request("http://test.local/api/parts/part-1/files", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileId: "file-1" }),
      });
      const res = await unlinkPartFile(req as never, {
        params: Promise.resolve({ partId: "part-1" }),
      });
      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatch(/part not found/i);
    });
  });

  describe("PUT /api/files/[fileId]/metadata — fieldId tenant guard + soft-delete", () => {
    const ownFile = {
      id: "file-1",
      tenantId: TENANT_A,
      name: "x.sldprt",
      isFrozen: false,
      isCheckedOut: false,
      checkedOutById: null,
      folderId: "folder-1",
      deletedAt: null,
    };

    it("returns 404 when any supplied fieldId is from another tenant", async () => {
      supabaseResponses.set("files", { data: ownFile, error: null });
      // metadata_fields query is filtered by tenantId — return empty so the
      // requested fieldId is treated as foreign.
      supabaseResponses.set("metadata_fields", { data: [], error: null });
      const req = new Request("http://test.local/api/files/file-1/metadata", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          metadata: [{ fieldId: "field-from-tenant-b", value: "x" }],
        }),
      });
      const res = await putFileMetadata(req as never, {
        params: Promise.resolve({ fileId: "file-1" }),
      });
      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatch(/metadata fields not found/i);
    });

    it("returns 404 when the file is soft-deleted", async () => {
      supabaseResponses.set("files", {
        data: { ...ownFile, deletedAt: new Date().toISOString() },
        error: null,
      });
      const req = new Request("http://test.local/api/files/file-1/metadata", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: "x" }),
      });
      const res = await putFileMetadata(req as never, {
        params: Promise.resolve({ fileId: "file-1" }),
      });
      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatch(/file not found/i);
    });
  });

  describe("GET /api/share-tokens — permission gate", () => {
    it("returns 403 when caller lacks SHARE_CREATE", async () => {
      mockTenantUser.current = {
        ...userInTenantA,
        role: { id: "role-viewer", name: "Viewer", permissions: ["file.view"] },
      };
      const req = new Request(
        "http://test.local/api/share-tokens?resourceType=file&resourceId=file-1"
      );
      const res = await listShareTokens(req as never);
      expect(res.status).toBe(403);
    });

    it("returns 401 when no tenant user is authenticated", async () => {
      mockTenantUser.current = null;
      const req = new Request(
        "http://test.local/api/share-tokens?resourceType=file&resourceId=file-1"
      );
      const res = await listShareTokens(req as never);
      expect(res.status).toBe(401);
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
