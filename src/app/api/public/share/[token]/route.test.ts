import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The share-resolve endpoint is reachable by anyone with a URL and no session
 * at all, so this suite is about what it refuses and what it declines to say.
 *
 * `@/lib/share-tokens` is deliberately NOT mocked — `resolveToken` runs for
 * real against the mocked database so the revoked/expired branches are under
 * test rather than stubbed into existence. The mock honours `.eq()` filters,
 * which is what lets "resolves a resource in the token's own tenant" be a real
 * assertion instead of a tautology.
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

    for (const m of ["select", "eq", "in", "is", "order", "limit"] as const) {
      chain[m] = (...args: unknown[]) => {
        if (m === "eq" && args.length === 2) filters[args[0] as string] = args[1];
        return chain;
      };
    }
    chain.single = () => resolvable();
    chain.maybeSingle = () => resolvable();
    chain.insert = () => Promise.resolve({ data: null, error: null });
    chain.update = () => {
      const u: Record<string, (...a: unknown[]) => unknown> = {};
      for (const m of ["eq", "select"] as const) u[m] = () => u;
      u.single = () => ({ data: null, error: null });
      u.then = ((r: (v: unknown) => void) => r({ data: null, error: null })) as never;
      return u;
    };
    chain.then = ((r: (v: unknown) => void) => r(resolvable())) as never;
    return chain;
  }

  return { tableResults, mockFrom: (table: string) => makeChain(table) };
});

vi.mock("@/lib/db", () => ({
  getServiceClient: () => ({ from: mockFrom }),
}));

import { GET } from "./route";

const TOKEN = "vJk3nQ7pR2sT5uW8xY1zA4bC6dE9fG0h";

let ipCounter = 0;
/**
 * A distinct source IP per request. The rate limiter keys per-IP buckets in a
 * module-level Map that outlives individual tests, so a shared IP would make
 * later tests fail on 429 depending on how many ran before them.
 */
function makeRequest(ip = `10.0.0.${++ipCounter % 250}`): NextRequest {
  return new NextRequest(`http://localhost/api/public/share/${TOKEN}`, {
    headers: { "x-forwarded-for": ip, "user-agent": "Mozilla/5.0" },
  });
}

const params = Promise.resolve({ token: TOKEN });

const liveToken = {
  id: "tok-1",
  tenantId: "tenant-1",
  token: TOKEN,
  resourceType: "file",
  resourceId: "file-1",
  createdById: "user-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
  revokedAt: null,
  allowDownload: true,
  passwordHash: null,
  label: null,
  accessCount: 0,
  lastAccessedAt: null,
  includeWip: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(tableResults)) delete tableResults[key];
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  tableResults["tenants"] = { data: { name: "Acme Inc" }, error: null };
});

describe("GET /api/public/share/[token]", () => {
  it("reports not_found for a token that matches nothing", async () => {
    tableResults["share_tokens"] = { data: null, error: null };
    const res = await GET(makeRequest(), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "not_found" });
  });

  it("reports revoked for a link the owner turned off", async () => {
    tableResults["share_tokens"] = {
      data: { ...liveToken, revokedAt: "2026-02-01T00:00:00.000Z" },
      error: null,
    };
    expect((await (await GET(makeRequest(), { params })).json()).status).toBe("revoked");
  });

  it("reports expired for a link past its expiry", async () => {
    tableResults["share_tokens"] = {
      data: { ...liveToken, expiresAt: new Date(Date.now() - 60_000).toISOString() },
      error: null,
    };
    expect((await (await GET(makeRequest(), { params })).json()).status).toBe("expired");
  });

  /**
   * A failed resolve leaks nothing about the resource: no name, no type, no
   * tenant. Someone holding a revoked link learns only that it is revoked.
   */
  it("returns no resource detail alongside a failure status", async () => {
    tableResults["share_tokens"] = {
      data: { ...liveToken, revokedAt: "2026-02-01T00:00:00.000Z" },
      error: null,
    };
    tableResults["files"] = { data: { name: "secret-bracket.sldprt" }, error: null };
    const body = await (await GET(makeRequest(), { params })).json();
    expect(Object.keys(body)).toEqual(["status"]);
  });

  it("resolves a file share to its display name", async () => {
    tableResults["share_tokens"] = { data: liveToken, error: null };
    tableResults["files"] = { data: { name: "bracket.sldprt" }, error: null };
    const body = await (await GET(makeRequest(), { params })).json();
    expect(body).toMatchObject({
      status: "ok",
      resourceType: "file",
      resourceName: "bracket.sldprt",
      allowDownload: true,
      sharedByTenantName: "Acme Inc",
    });
  });

  it("scopes the resource lookup to the token's tenant and skips soft-deleted rows", async () => {
    tableResults["share_tokens"] = { data: liveToken, error: null };
    // Serve the file only to the tenant that owns the token. A lookup missing
    // the tenant filter would still find it and leak the name across tenants.
    tableResults["files"] = (filters) =>
      filters.tenantId === "tenant-1"
        ? { data: { name: "bracket.sldprt" }, error: null }
        : { data: null, error: null };
    expect((await (await GET(makeRequest(), { params })).json()).resourceName).toBe(
      "bracket.sldprt"
    );
  });

  it("degrades to not_found when the shared resource has been deleted", async () => {
    tableResults["share_tokens"] = { data: liveToken, error: null };
    tableResults["files"] = { data: null, error: null };
    const body = await (await GET(makeRequest(), { params })).json();
    expect(body).toEqual({ status: "not_found" });
  });

  it("names a bom share by its name", async () => {
    tableResults["share_tokens"] = { data: { ...liveToken, resourceType: "bom" }, error: null };
    tableResults["boms"] = { data: { name: "Gearbox top level" }, error: null };
    expect((await (await GET(makeRequest(), { params })).json()).resourceName).toBe(
      "Gearbox top level"
    );
  });

  it("names a part share by part number and revision, not its description", async () => {
    tableResults["share_tokens"] = { data: { ...liveToken, resourceType: "part" }, error: null };
    tableResults["parts"] = { data: { partNumber: "PN-1042", revision: "C" }, error: null };
    expect((await (await GET(makeRequest(), { params })).json()).resourceName).toBe(
      "PN-1042 rev C"
    );
  });

  it("names a release share by its name", async () => {
    tableResults["share_tokens"] = { data: { ...liveToken, resourceType: "release" }, error: null };
    tableResults["releases"] = { data: { name: "R2026.02" }, error: null };
    expect((await (await GET(makeRequest(), { params })).json()).resourceName).toBe("R2026.02");
  });

  /**
   * The viewer needs to know a password is required so it can render the gate.
   * It must not learn anything about the password itself.
   */
  it("advertises that a password is required without exposing the hash", async () => {
    tableResults["share_tokens"] = {
      data: { ...liveToken, passwordHash: "abc:def" },
      error: null,
    };
    tableResults["files"] = { data: { name: "bracket.sldprt" }, error: null };
    const body = await (await GET(makeRequest(), { params })).json();
    expect(body.requiresPassword).toBe(true);
    expect(JSON.stringify(body)).not.toContain("abc:def");
  });

  it("reports requiresPassword false for an open link", async () => {
    tableResults["share_tokens"] = { data: liveToken, error: null };
    tableResults["files"] = { data: { name: "bracket.sldprt" }, error: null };
    expect((await (await GET(makeRequest(), { params })).json()).requiresPassword).toBe(false);
  });

  it("marks every response noindex so shared links stay out of search results", async () => {
    tableResults["share_tokens"] = { data: liveToken, error: null };
    tableResults["files"] = { data: { name: "bracket.sldprt" }, error: null };
    expect((await GET(makeRequest(), { params })).headers.get("X-Robots-Tag")).toBe(
      "noindex, nofollow"
    );

    tableResults["share_tokens"] = { data: null, error: null };
    expect((await GET(makeRequest(), { params })).headers.get("X-Robots-Tag")).toBe(
      "noindex, nofollow"
    );
  });

  it("rate-limits a single IP hammering the endpoint", async () => {
    tableResults["share_tokens"] = { data: null, error: null };
    const ip = "198.51.100.42"; // fixed, so all attempts share one bucket
    let limited = null;
    // Default bucket is 30 with a 1/sec refill; 40 back-to-back must trip it.
    for (let i = 0; i < 40; i++) {
      const res = await GET(makeRequest(ip), { params });
      if (res.status === 429) {
        limited = res;
        break;
      }
    }
    expect(limited).not.toBeNull();
    expect(limited!.headers.get("Retry-After")).toBe("30");
  });

  it("returns 500 with a message when the lookup throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    tableResults["share_tokens"] = () => {
      throw new Error("connection reset");
    };
    const res = await GET(makeRequest(), { params });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("connection reset");
    err.mockRestore();
  });
});
