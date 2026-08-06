import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Unlock is the brute-force surface: an unauthenticated POST that accepts a
 * password guess. The cases that matter are the refusals, and the exact shape
 * of the cookie it hands back on success — that cookie is the only thing the
 * content and zip endpoints check.
 *
 * `@/lib/share-tokens` runs for real (only the database is mocked), so the
 * password comparison and the HMAC on the cookie are genuinely exercised.
 */

const { tableResults, mockFrom } = vi.hoisted(() => {
  type QueryResult = { data: unknown; error: unknown };
  const tableResults: Record<string, QueryResult> = {};

  function makeChain(table: string) {
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    const resolvable = () => tableResults[table] ?? { data: null, error: null };
    for (const m of ["select", "eq", "in", "is", "order", "limit"] as const) {
      chain[m] = () => chain;
    }
    chain.single = () => resolvable();
    chain.maybeSingle = () => resolvable();
    chain.insert = () => Promise.resolve({ data: null, error: null });
    chain.then = ((r: (v: unknown) => void) => r(resolvable())) as never;
    return chain;
  }

  return { tableResults, mockFrom: (table: string) => makeChain(table) };
});

vi.mock("@/lib/db", () => ({
  getServiceClient: () => ({ from: mockFrom }),
}));

import { POST } from "./route";
import { hashPassword, unlockCookieName, verifyUnlockCookie } from "@/lib/share-tokens";

const TOKEN = "vJk3nQ7pR2sT5uW8xY1zA4bC6dE9fG0h";

let ipCounter = 0;
/** Unique IP per request — the unlock bucket is only 10 deep per IP. */
function makeRequest(body: unknown, ip = `10.1.0.${++ipCounter % 250}`): NextRequest {
  return new NextRequest(`http://localhost/api/public/share/${TOKEN}/unlock`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const params = Promise.resolve({ token: TOKEN });

const baseToken = {
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
  passwordHash: null as string | null,
  label: null,
  accessCount: 0,
  lastAccessedAt: null,
  includeWip: false,
};

/** Put a password-gated token in the database, hashed the way the app does. */
async function givenGatedToken(password: string, overrides: Record<string, unknown> = {}) {
  tableResults["share_tokens"] = {
    data: { ...baseToken, passwordHash: await hashPassword(password), ...overrides },
    error: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(tableResults)) delete tableResults[key];
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
});

describe("POST /api/public/share/[token]/unlock", () => {
  it("returns 404 for a token that matches nothing", async () => {
    tableResults["share_tokens"] = { data: null, error: null };
    const res = await POST(makeRequest({ password: "anything" }), { params });
    expect(res.status).toBe(404);
  });

  it("returns 404 for a revoked token rather than checking the password", async () => {
    await givenGatedToken("hunter2", { revokedAt: "2026-02-01T00:00:00.000Z" });
    const res = await POST(makeRequest({ password: "hunter2" }), { params });
    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it("returns 404 for an expired token even with the right password", async () => {
    await givenGatedToken("hunter2", {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const res = await POST(makeRequest({ password: "hunter2" }), { params });
    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  /**
   * A link with no password has nothing to unlock. Answering 404 rather than
   * "ok" keeps this endpoint from minting an unlock cookie for a share whose
   * content endpoint would never ask for one.
   */
  it("returns 404 for a link that has no password", async () => {
    tableResults["share_tokens"] = { data: { ...baseToken, passwordHash: null }, error: null };
    const res = await POST(makeRequest({ password: "anything" }), { params });
    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it("returns 400 for a body that is not valid JSON", async () => {
    await givenGatedToken("hunter2");
    const res = await POST(makeRequest("{not json"), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid JSON body");
  });

  it("returns 400 for a missing or empty password", async () => {
    await givenGatedToken("hunter2");
    expect((await POST(makeRequest({}), { params })).status).toBe(400);
    expect((await POST(makeRequest({ password: "" }), { params })).status).toBe(400);
  });

  it("returns 400 for an absurdly long password instead of hashing it", async () => {
    await givenGatedToken("hunter2");
    const res = await POST(makeRequest({ password: "x".repeat(201) }), { params });
    expect(res.status).toBe(400);
  });

  it("returns 401 and sets no cookie for a wrong password", async () => {
    await givenGatedToken("hunter2");
    const res = await POST(makeRequest({ password: "hunter3" }), { params });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Incorrect password");
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it("accepts the right password and issues a cookie the content endpoint will honour", async () => {
    await givenGatedToken("hunter2");
    const res = await POST(makeRequest({ password: "hunter2" }), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const value = res.cookies.get(unlockCookieName(TOKEN))?.value;
    expect(value).toBeTruthy();
    // The real check: this is exactly what /content and /zip will verify.
    expect(verifyUnlockCookie(TOKEN, value)).toBe(true);
  });

  /**
   * The API cookie is path-scoped to this share and httpOnly, so it neither
   * rides along on other shares' requests nor is readable from script. The
   * second, page-scoped cookie is only a "you are unlocked" hint for the
   * viewer, so it is deliberately not httpOnly — but it also carries no
   * secret, just "1".
   */
  it("scopes the API cookie to this share's path and keeps it httpOnly", async () => {
    await givenGatedToken("hunter2");
    const res = await POST(makeRequest({ password: "hunter2" }), { params });

    const api = res.cookies.get(unlockCookieName(TOKEN))!;
    expect(api.path).toBe(`/api/public/share/${TOKEN}`);
    expect(api.httpOnly).toBe(true);
    expect(api.sameSite).toBe("lax");
    expect(api.maxAge).toBe(3600);

    const page = res.cookies.get(`${unlockCookieName(TOKEN)}_page`)!;
    expect(page.path).toBe(`/share/${TOKEN}`);
    expect(page.value).toBe("1");
  });

  it("issues a cookie that does not unlock a different share", async () => {
    await givenGatedToken("hunter2");
    const res = await POST(makeRequest({ password: "hunter2" }), { params });
    const value = res.cookies.get(unlockCookieName(TOKEN))!.value;
    expect(verifyUnlockCookie("a-completely-different-token-value", value)).toBe(false);
  });

  /**
   * Ten guesses per IP per minute. This is the endpoint an attacker would
   * hammer, so the limit tripping is worth asserting directly rather than
   * trusting the config object.
   */
  it("rate-limits password guessing well below the default bucket", async () => {
    await givenGatedToken("hunter2");
    const ip = "198.51.100.77";
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      statuses.push((await POST(makeRequest({ password: "wrong" }, ip), { params })).status);
    }
    expect(statuses).toContain(429);
    // The limit must bite inside the first dozen attempts, not at 30.
    expect(statuses.indexOf(429)).toBeLessThanOrEqual(11);
  });

  it("returns 500 with a message when resolving throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.SUPABASE_SERVICE_ROLE_KEY; // signing key missing
    await givenGatedToken("hunter2");
    const res = await POST(makeRequest({ password: "hunter2" }), { params });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    err.mockRestore();
  });
});
