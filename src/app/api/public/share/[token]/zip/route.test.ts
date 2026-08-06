import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The zip endpoint hands a stranger every file in a release or part package at
 * once, so it carries a gate the other public routes do not: `allowDownload`.
 * A link created for viewing only must not yield a zip, and the ordering of
 * the checks matters — a 404 for a missing release must not be recorded as a
 * successful zip-download against the token.
 *
 * `@/lib/share-tokens` runs for real against the mocked database so the
 * password cookie check is genuinely exercised.
 */

const { tableResults, mockFrom, accessInserts } = vi.hoisted(() => {
  type QueryResult = { data: unknown; error: unknown };
  const tableResults: Record<string, QueryResult> = {};
  const accessInserts: Array<Record<string, unknown>> = [];

  function makeChain(table: string) {
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    const resolvable = () => tableResults[table] ?? { data: null, error: null };
    for (const m of ["select", "eq", "in", "is", "order", "limit"] as const) chain[m] = () => chain;
    chain.single = () => resolvable();
    chain.maybeSingle = () => resolvable();
    chain.insert = (data: unknown) => {
      if (table === "share_token_access") accessInserts.push(data as Record<string, unknown>);
      return Promise.resolve({ data: null, error: null });
    };
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

  return { tableResults, accessInserts, mockFrom: (t: string) => makeChain(t) };
});

const { releaseResult, packageResult } = vi.hoisted(() => ({
  releaseResult: { current: null as unknown },
  packageResult: { current: null as unknown },
}));

vi.mock("@/lib/db", () => ({
  getServiceClient: () => ({ from: mockFrom, storage: { from: () => ({}) } }),
}));

vi.mock("@/lib/releases", () => ({
  getReleaseById: vi.fn(async () => releaseResult.current),
  buildReleaseZipStream: vi.fn(
    () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([0x50, 0x4b])); // "PK"
          c.close();
        },
      })
  ),
  releaseZipFilename: vi.fn(() => "R2026.02.zip"),
}));

vi.mock("@/lib/part-package", () => ({
  buildPartPackage: vi.fn(async () => packageResult.current),
  buildPartZipStream: vi.fn(
    () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([0x50, 0x4b]));
          c.close();
        },
      })
  ),
  partZipFilename: vi.fn(() => "PN-1042_revC.zip"),
}));

import { GET } from "./route";
import { unlockCookieName, unlockCookieValue, hashPassword } from "@/lib/share-tokens";
import { buildPartZipStream } from "@/lib/part-package";
import { buildReleaseZipStream } from "@/lib/releases";

const TOKEN = "vJk3nQ7pR2sT5uW8xY1zA4bC6dE9fG0h";

let ipCounter = 0;
function makeRequest(opts: { cookie?: string; ip?: string } = {}): NextRequest {
  const headers: Record<string, string> = {
    "x-forwarded-for": opts.ip ?? `10.3.0.${++ipCounter % 250}`,
  };
  if (opts.cookie) headers.cookie = opts.cookie;
  return new NextRequest(`http://localhost/api/public/share/${TOKEN}/zip`, { headers });
}

const params = Promise.resolve({ token: TOKEN });

const baseToken = {
  id: "tok-1",
  tenantId: "tenant-1",
  token: TOKEN,
  resourceType: "release",
  resourceId: "rel-1",
  createdById: "user-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
  revokedAt: null,
  allowDownload: true,
  passwordHash: null as string | null,
  label: null,
  accessCount: 0,
  lastAccessedAt: null,
  includeWip: false,
};

function givenToken(overrides: Record<string, unknown> = {}) {
  tableResults["share_tokens"] = { data: { ...baseToken, ...overrides }, error: null };
}

const release = {
  name: "R2026.02",
  ecoNumber: "ECO-0042",
  releasedAt: "2026-02-01T00:00:00.000Z",
  note: null,
  manifest: { files: [] },
};

const pkg = { partNumber: "PN-1042", revision: "C", files: [], boms: [] };

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(tableResults)) delete tableResults[key];
  accessInserts.length = 0;
  releaseResult.current = release;
  packageResult.current = pkg;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
});

describe("GET /api/public/share/[token]/zip", () => {
  it("404s a token that matches nothing", async () => {
    tableResults["share_tokens"] = { data: null, error: null };
    const res = await GET(makeRequest(), { params });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });

  it("404s a revoked or expired link", async () => {
    givenToken({ revokedAt: "2026-02-01T00:00:00.000Z" });
    expect((await GET(makeRequest(), { params })).status).toBe(404);

    givenToken({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    expect((await GET(makeRequest(), { params })).status).toBe(404);
  });

  /**
   * A file share already hands over its one file and a BOM share is a table
   * with no attachments, so neither has a zip to build.
   */
  it.each(["file", "bom"] as const)("400s a %s share, which has no zip", async (resourceType) => {
    givenToken({ resourceType });
    const res = await GET(makeRequest(), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/only available for release and part/i);
  });

  /**
   * The download gate. A view-only link must not yield a bulk archive, and
   * this must be decided before any content is resolved.
   */
  it("403s a view-only link", async () => {
    givenToken({ allowDownload: false });
    const res = await GET(makeRequest(), { params });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/not allowed/i);
    expect(buildReleaseZipStream).not.toHaveBeenCalled();
  });

  it("403s a view-only part link too", async () => {
    givenToken({ resourceType: "part", resourceId: "part-1", allowDownload: false });
    expect((await GET(makeRequest(), { params })).status).toBe(403);
    expect(buildPartZipStream).not.toHaveBeenCalled();
  });

  it("401s a password-gated link with no unlock cookie", async () => {
    givenToken({ passwordHash: await hashPassword("hunter2") });
    const res = await GET(makeRequest(), { params });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("password_required");
    expect(buildReleaseZipStream).not.toHaveBeenCalled();
  });

  it("401s a cookie minted for a different share", async () => {
    givenToken({ passwordHash: await hashPassword("hunter2") });
    const other = unlockCookieValue("some-entirely-different-token");
    const res = await GET(makeRequest({ cookie: `${unlockCookieName(TOKEN)}=${other}` }), {
      params,
    });
    expect(res.status).toBe(401);
  });

  it("streams the zip once the correct unlock cookie is present", async () => {
    givenToken({ passwordHash: await hashPassword("hunter2") });
    const cookie = `${unlockCookieName(TOKEN)}=${unlockCookieValue(TOKEN)}`;
    const res = await GET(makeRequest({ cookie }), { params });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
  });

  it("streams a release zip with download headers and no caching", async () => {
    givenToken();
    const res = await GET(makeRequest(), { params });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="R2026.02.zip"');
    // A zip carries a short-lived view of released files; a shared cache must
    // not hold it after the link is revoked.
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0x50, 0x4b]));
  });

  it("streams a part zip for a part share", async () => {
    givenToken({ resourceType: "part", resourceId: "part-1" });
    const res = await GET(makeRequest(), { params });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="PN-1042_revC.zip"');
    expect(buildPartZipStream).toHaveBeenCalled();
  });

  it("passes the link's includeWip setting to the package builder", async () => {
    const { buildPartPackage } = await import("@/lib/part-package");
    givenToken({ resourceType: "part", resourceId: "part-1", includeWip: true });
    await GET(makeRequest(), { params });
    expect(buildPartPackage).toHaveBeenCalledWith(expect.anything(), "tenant-1", "part-1", {
      includeWip: true,
    });
  });

  it("404s when the release cannot be resolved in the token's tenant", async () => {
    givenToken();
    releaseResult.current = null;
    const res = await GET(makeRequest(), { params });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Release not found");
  });

  it("404s when the part package cannot be built", async () => {
    givenToken({ resourceType: "part", resourceId: "part-1" });
    packageResult.current = null;
    const res = await GET(makeRequest(), { params });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Part not found");
  });

  /**
   * The audit trail is what the activity panel and any forensic review read.
   * A 404 must not leave a `zip-download` row implying files went out — hence
   * the route resolving the target before it logs.
   */
  it("logs no zip-download when the target could not be resolved", async () => {
    givenToken();
    releaseResult.current = null;
    await GET(makeRequest(), { params });
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget log settle
    expect(accessInserts.filter((r) => r.action === "zip-download")).toHaveLength(0);
  });

  it("logs a zip-download with the caller's IP on success", async () => {
    givenToken();
    await GET(makeRequest({ ip: "203.0.113.5" }), { params });
    await new Promise((r) => setTimeout(r, 0));
    const logged = accessInserts.filter((r) => r.action === "zip-download");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      tenantId: "tenant-1",
      tokenId: "tok-1",
      resourceType: "release",
      success: true,
      ipAddress: "203.0.113.5",
    });
  });

  it("rate-limits a single IP", async () => {
    tableResults["share_tokens"] = { data: null, error: null };
    const ip = "198.51.100.31";
    let sawLimit = false;
    for (let i = 0; i < 40 && !sawLimit; i++) {
      sawLimit = (await GET(makeRequest({ ip }), { params })).status === 429;
    }
    expect(sawLimit).toBe(true);
  });
});
