import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Share tokens are the only part of this app an unauthenticated stranger can
 * reach, so the tests lean on the three things that keep a link from becoming
 * a hole in the vault:
 *
 *   1. `resolveToken` distinguishes revoked and expired from valid. A link the
 *      owner revoked must stop working immediately, not at the next expiry.
 *   2. `verifyPassword` and `verifyUnlockCookie` reject everything except the
 *      exact right value — including the shapes that tempt a short-circuit
 *      (empty cookie, truncated hash, malformed stored record).
 *   3. The tenant-scoped reads carry `.eq("tenantId", …)`. These helpers take a
 *      raw service client, so nothing else applies the filter for them.
 *
 * The mock records the filters each query applied so (3) can be asserted
 * directly rather than inferred from an empty result — see
 * docs/decisions/testing-strategy.md.
 */

const { tableResults, calls, mockFrom } = vi.hoisted(() => {
  type QueryResult = { data: unknown; error: unknown };
  type Handler = QueryResult | ((filters: Record<string, unknown>) => QueryResult);

  const tableResults: Record<string, Handler> = {};
  const calls: Array<{
    table: string;
    op: "select" | "insert" | "update";
    data?: unknown;
    filters: Record<string, unknown>;
  }> = [];

  function makeChain(table: string) {
    const filters: Record<string, unknown> = {};
    const chain: Record<string, (...args: unknown[]) => unknown> = {};

    const resolvable = (): QueryResult => {
      const handler = tableResults[table];
      if (typeof handler === "function") return handler(filters);
      return handler ?? { data: null, error: null };
    };

    for (const m of ["select", "eq", "in", "is", "lt", "order", "limit"] as const) {
      chain[m] = (...args: unknown[]) => {
        if (m === "select") calls.push({ table, op: "select", filters });
        if (m === "eq" && args.length === 2) filters[args[0] as string] = args[1];
        if (m === "in" && args.length === 2) filters[args[0] as string] = args[1];
        if (m === "lt" && args.length === 2) filters[`${args[0] as string}<`] = args[1];
        return chain;
      };
    }

    chain.single = () => resolvable();
    chain.maybeSingle = () => resolvable();

    chain.insert = (data: unknown) => {
      calls.push({ table, op: "insert", data, filters: { ...filters } });
      const insertChain: Record<string, (...args: unknown[]) => unknown> = {};
      insertChain.select = () => insertChain;
      insertChain.single = () => resolvable();
      insertChain.then = ((resolve: (v: unknown) => void) =>
        resolve({ data: null, error: null })) as unknown as (...args: unknown[]) => unknown;
      return insertChain;
    };

    chain.update = (data: unknown) => {
      const entry = { table, op: "update" as const, data, filters: { ...filters } };
      calls.push(entry);
      const updateChain: Record<string, (...args: unknown[]) => unknown> = {};
      for (const m of ["eq", "in", "select"] as const) {
        updateChain[m] = (...args: unknown[]) => {
          if (m === "eq" && args.length === 2) entry.filters[args[0] as string] = args[1];
          return updateChain;
        };
      }
      updateChain.single = () => resolvable();
      updateChain.then = ((resolve: (v: unknown) => void) =>
        resolve({ data: null, error: null })) as unknown as (...args: unknown[]) => unknown;
      return updateChain;
    };

    chain.then = ((resolve: (v: unknown) => void) => resolve(resolvable())) as unknown as (
      ...args: unknown[]
    ) => unknown;

    return chain;
  }

  return { tableResults, calls, mockFrom: (table: string) => makeChain(table) };
});

vi.mock("@/lib/db", () => ({
  getServiceClient: () => ({ from: mockFrom }),
}));

vi.mock("uuid", () => ({ v4: () => "mock-uuid" }));

import {
  generateToken,
  hashPassword,
  verifyPassword,
  unlockCookieName,
  unlockCookieValue,
  verifyUnlockCookie,
  createShareToken,
  listShareTokensForResource,
  revokeShareToken,
  resolveToken,
  bumpAccessCount,
  logShareAccess,
  listShareTokenAccess,
  getShareTokenById,
  type ShareTokenRow,
} from "./share-tokens";

const TOKEN = "vJk3nQ7pR2sT5uW8xY1zA4bC6dE9fG0h";

const liveToken: ShareTokenRow = {
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
  label: "For the machine shop",
  accessCount: 3,
  lastAccessedAt: null,
  includeWip: false,
};

/** Filters recorded by the most recent query against `table`. */
function filtersFor(table: string, op: "select" | "insert" | "update") {
  const match = [...calls].reverse().find((c) => c.table === table && c.op === op);
  return match?.filters ?? {};
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  for (const key of Object.keys(tableResults)) delete tableResults[key];
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
});

// ── Token generation ────────────────────────────────────────────────────────

describe("generateToken", () => {
  it("produces a URL-safe string with no padding or reserved characters", () => {
    for (let i = 0; i < 25; i++) {
      expect(generateToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("produces 24 bytes of entropy — 32 base64url characters", () => {
    expect(generateToken()).toHaveLength(32);
  });

  it("does not repeat across calls", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateToken()));
    expect(seen.size).toBe(200);
  });
});

// ── Password hashing ────────────────────────────────────────────────────────

describe("hashPassword / verifyPassword", () => {
  it("round-trips the correct password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const stored = await hashPassword("s3cret");
    expect(await verifyPassword("s3cret ", stored)).toBe(false);
    expect(await verifyPassword("S3cret", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("salts each hash, so the same password stores differently every time", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    // Both still verify — the salt travels with the hash.
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });

  it("stores salt and hash as hex halves of a colon-delimited record", async () => {
    const stored = await hashPassword("pw");
    const [salt, hash] = stored.split(":");
    expect(salt).toMatch(/^[0-9a-f]{32}$/); // 16 bytes
    expect(hash).toMatch(/^[0-9a-f]{128}$/); // 64 bytes
  });

  /**
   * A malformed stored value must fail closed. Returning true — or throwing
   * past the caller — on a record the migration mangled would turn a corrupt
   * row into an open door.
   */
  it("returns false rather than throwing on a malformed stored record", async () => {
    expect(await verifyPassword("pw", "")).toBe(false);
    expect(await verifyPassword("pw", "no-colon-at-all")).toBe(false);
    expect(await verifyPassword("pw", ":")).toBe(false);
    expect(await verifyPassword("pw", "deadbeef:")).toBe(false);
    expect(await verifyPassword("pw", ":deadbeef")).toBe(false);
    expect(await verifyPassword("pw", "nothex:nothex")).toBe(false);
  });

  it("rejects a hash truncated to its first bytes", async () => {
    const stored = await hashPassword("pw");
    const [salt, hash] = stored.split(":");
    // A comparison that only checked a prefix would accept this.
    expect(await verifyPassword("pw", `${salt}:${hash.slice(0, 16)}`)).toBe(false);
  });
});

// ── Unlock cookie ───────────────────────────────────────────────────────────

describe("unlock cookie", () => {
  it("names the cookie per-token so two shares do not collide in one browser", () => {
    const a = unlockCookieName("aaaaaaaaaaaaSUFFIX");
    const b = unlockCookieName("bbbbbbbbbbbbSUFFIX");
    expect(a).not.toBe(b);
    expect(a).toBe("share_unlock_aaaaaaaaaaaa");
  });

  it("accepts the value it just issued", () => {
    expect(verifyUnlockCookie(TOKEN, unlockCookieValue(TOKEN))).toBe(true);
  });

  it("rejects a missing cookie", () => {
    expect(verifyUnlockCookie(TOKEN, undefined)).toBe(false);
    expect(verifyUnlockCookie(TOKEN, "")).toBe(false);
  });

  /**
   * The signature is over the token, so a cookie minted for one share must
   * not unlock another. Without this the path-scoping on the cookie would be
   * the only thing standing between two links — and a client controls paths.
   */
  it("rejects a cookie signed for a different token", () => {
    const other = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
    expect(verifyUnlockCookie(TOKEN, unlockCookieValue(other))).toBe(false);
  });

  it("rejects a tampered value of the same length", () => {
    const value = unlockCookieValue(TOKEN);
    const flipped = (value[0] === "A" ? "B" : "A") + value.slice(1);
    expect(flipped).toHaveLength(value.length);
    expect(verifyUnlockCookie(TOKEN, flipped)).toBe(false);
  });

  it("rejects a truncated value without throwing on the length mismatch", () => {
    const value = unlockCookieValue(TOKEN);
    expect(verifyUnlockCookie(TOKEN, value.slice(0, -1))).toBe(false);
    expect(verifyUnlockCookie(TOKEN, value + "x")).toBe(false);
  });

  it("changes signature when the signing key changes", () => {
    const before = unlockCookieValue(TOKEN);
    process.env.SUPABASE_SERVICE_ROLE_KEY = "a-different-key";
    expect(unlockCookieValue(TOKEN)).not.toBe(before);
    // A cookie issued under the old key no longer validates.
    expect(verifyUnlockCookie(TOKEN, before)).toBe(false);
  });

  it("throws rather than signing with an empty key", () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(() => unlockCookieValue(TOKEN)).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});

// ── resolveToken ────────────────────────────────────────────────────────────

describe("resolveToken", () => {
  it("returns not_found when no row matches", async () => {
    tableResults["share_tokens"] = { data: null, error: null };
    expect(await resolveToken(TOKEN)).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns not_found when the query errors", async () => {
    tableResults["share_tokens"] = { data: null, error: { message: "boom" } };
    expect(await resolveToken(TOKEN)).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns revoked for a revoked link, even if it has not expired", async () => {
    tableResults["share_tokens"] = {
      data: { ...liveToken, revokedAt: "2026-01-02T00:00:00.000Z", expiresAt: null },
      error: null,
    };
    expect(await resolveToken(TOKEN)).toEqual({ ok: false, reason: "revoked" });
  });

  it("returns expired for a link past its expiry", async () => {
    tableResults["share_tokens"] = {
      data: { ...liveToken, expiresAt: new Date(Date.now() - 60_000).toISOString() },
      error: null,
    };
    expect(await resolveToken(TOKEN)).toEqual({ ok: false, reason: "expired" });
  });

  it("reports revoked ahead of expired when a link is both", async () => {
    // The owner revoking is the more specific fact, and the copy the viewer
    // sees should say so.
    tableResults["share_tokens"] = {
      data: {
        ...liveToken,
        revokedAt: "2026-01-02T00:00:00.000Z",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
      error: null,
    };
    expect(await resolveToken(TOKEN)).toEqual({ ok: false, reason: "revoked" });
  });

  it("resolves a link whose expiry is still in the future", async () => {
    const row = { ...liveToken, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    tableResults["share_tokens"] = { data: row, error: null };
    const result = await resolveToken(TOKEN);
    expect(result.ok).toBe(true);
    expect(result.ok && result.token.id).toBe("tok-1");
  });

  it("resolves a link with no expiry at all", async () => {
    tableResults["share_tokens"] = { data: liveToken, error: null };
    expect((await resolveToken(TOKEN)).ok).toBe(true);
  });

  it("looks the row up by the public token value", async () => {
    tableResults["share_tokens"] = { data: liveToken, error: null };
    await resolveToken(TOKEN);
    expect(filtersFor("share_tokens", "select").token).toBe(TOKEN);
  });

  it("does not bump the access counter — that is the content endpoint's job", async () => {
    tableResults["share_tokens"] = { data: liveToken, error: null };
    await resolveToken(TOKEN);
    expect(calls.filter((c) => c.op === "update")).toHaveLength(0);
  });
});

// ── createShareToken ────────────────────────────────────────────────────────

describe("createShareToken", () => {
  const input = {
    tenantId: "tenant-1",
    createdById: "user-1",
    resourceType: "file" as const,
    resourceId: "file-1",
    expiresAt: null,
    allowDownload: true,
    password: null,
    label: null,
  };

  it("stamps the tenant and stores no password hash when none was given", async () => {
    tableResults["share_tokens"] = { data: { ...liveToken }, error: null };
    await createShareToken(input);
    const row = calls.find((c) => c.op === "insert")!.data as Record<string, unknown>;
    expect(row.tenantId).toBe("tenant-1");
    expect(row.passwordHash).toBeNull();
    expect(row.revokedAt).toBeNull();
    expect(row.accessCount).toBe(0);
  });

  it("hashes the password rather than storing it", async () => {
    tableResults["share_tokens"] = { data: { ...liveToken }, error: null };
    await createShareToken({ ...input, password: "hunter2" });
    const row = calls.find((c) => c.op === "insert")!.data as Record<string, unknown>;
    expect(row.passwordHash).not.toBe("hunter2");
    expect(row.passwordHash as string).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(await verifyPassword("hunter2", row.passwordHash as string)).toBe(true);
  });

  it("serialises an expiry date to ISO, and keeps null as null", async () => {
    tableResults["share_tokens"] = { data: { ...liveToken }, error: null };
    await createShareToken({ ...input, expiresAt: new Date("2026-12-25T00:00:00.000Z") });
    let row = calls.find((c) => c.op === "insert")!.data as Record<string, unknown>;
    expect(row.expiresAt).toBe("2026-12-25T00:00:00.000Z");

    calls.length = 0;
    await createShareToken(input);
    row = calls.find((c) => c.op === "insert")!.data as Record<string, unknown>;
    expect(row.expiresAt).toBeNull();
  });

  /**
   * `includeWip` widens a share to unreleased documents. Anything short of an
   * explicit `true` must store `false` — an undefined or truthy-ish value
   * silently leaking WIP drawings to a supplier is the failure that matters.
   */
  it("only sets includeWip on an explicit true", async () => {
    tableResults["share_tokens"] = { data: { ...liveToken }, error: null };
    for (const [given, expected] of [
      [undefined, false],
      [false, false],
      [true, true],
    ] as const) {
      calls.length = 0;
      await createShareToken({ ...input, resourceType: "part", includeWip: given });
      const row = calls.find((c) => c.op === "insert")!.data as Record<string, unknown>;
      expect(row.includeWip).toBe(expected);
    }
  });

  it("throws when the insert fails", async () => {
    tableResults["share_tokens"] = { data: null, error: { message: "duplicate token" } };
    await expect(createShareToken(input)).rejects.toMatchObject({ message: "duplicate token" });
  });
});

// ── Tenant-scoped reads and writes ──────────────────────────────────────────

describe("listShareTokensForResource", () => {
  it("filters by tenant as well as resource", async () => {
    tableResults["share_tokens"] = { data: [liveToken], error: null };
    await listShareTokensForResource("tenant-1", "bom", "bom-9");
    expect(filtersFor("share_tokens", "select")).toMatchObject({
      tenantId: "tenant-1",
      resourceType: "bom",
      resourceId: "bom-9",
    });
  });

  it("returns an empty array when the table has nothing", async () => {
    tableResults["share_tokens"] = { data: null, error: null };
    expect(await listShareTokensForResource("tenant-1", "file", "file-1")).toEqual([]);
  });

  it("throws when the query errors", async () => {
    tableResults["share_tokens"] = { data: null, error: { message: "nope" } };
    await expect(listShareTokensForResource("tenant-1", "file", "file-1")).rejects.toMatchObject({
      message: "nope",
    });
  });
});

describe("revokeShareToken", () => {
  it("scopes the update to the caller's tenant, not just the token id", async () => {
    tableResults["share_tokens"] = { data: { ...liveToken, revokedAt: "now" }, error: null };
    await revokeShareToken("tenant-1", "tok-1");
    // Without the tenant filter, any tenant could revoke any link by id.
    expect(filtersFor("share_tokens", "update")).toMatchObject({
      id: "tok-1",
      tenantId: "tenant-1",
    });
  });

  it("stamps revokedAt", async () => {
    tableResults["share_tokens"] = { data: { ...liveToken }, error: null };
    await revokeShareToken("tenant-1", "tok-1");
    const update = calls.find((c) => c.op === "update")!.data as Record<string, unknown>;
    expect(typeof update.revokedAt).toBe("string");
  });

  it("returns null when nothing matched", async () => {
    tableResults["share_tokens"] = { data: null, error: { message: "no rows" } };
    expect(await revokeShareToken("tenant-1", "tok-missing")).toBeNull();
  });
});

describe("getShareTokenById", () => {
  it("filters by tenant as well as id", async () => {
    tableResults["share_tokens"] = { data: liveToken, error: null };
    await getShareTokenById("tenant-1", "tok-1");
    expect(filtersFor("share_tokens", "select")).toMatchObject({
      id: "tok-1",
      tenantId: "tenant-1",
    });
  });

  it("returns null for a token in another tenant", async () => {
    tableResults["share_tokens"] = (filters) =>
      filters.tenantId === "tenant-OWNER"
        ? { data: liveToken, error: null }
        : { data: null, error: null };
    expect(await getShareTokenById("tenant-INTRUDER", "tok-1")).toBeNull();
    expect(await getShareTokenById("tenant-OWNER", "tok-1")).toMatchObject({ id: "tok-1" });
  });
});

describe("bumpAccessCount", () => {
  it("increments the stored count and stamps lastAccessedAt", async () => {
    tableResults["share_tokens"] = { data: { accessCount: 41 }, error: null };
    await bumpAccessCount("tok-1");
    const update = calls.find((c) => c.op === "update")!.data as Record<string, unknown>;
    expect(update.accessCount).toBe(42);
    expect(typeof update.lastAccessedAt).toBe("string");
  });

  it("treats a missing row as a count of zero rather than NaN", async () => {
    tableResults["share_tokens"] = { data: null, error: null };
    await bumpAccessCount("tok-1");
    const update = calls.find((c) => c.op === "update")!.data as Record<string, unknown>;
    expect(update.accessCount).toBe(1);
  });
});

// ── Access log ──────────────────────────────────────────────────────────────

describe("logShareAccess", () => {
  it("records a successful access with the defaults filled in", async () => {
    logShareAccess({
      tenantId: "tenant-1",
      tokenId: "tok-1",
      resourceType: "file",
      resourceId: "file-1",
      action: "view-content",
    });
    await vi.waitFor(() => expect(calls.filter((c) => c.op === "insert")).toHaveLength(1));
    const row = calls.find((c) => c.op === "insert")!.data as Record<string, unknown>;
    expect(row).toMatchObject({
      tenantId: "tenant-1",
      tokenId: "tok-1",
      action: "view-content",
      success: true,
      failureReason: null,
      fileId: null,
      ipAddress: null,
    });
  });

  it("records a failure with its reason", async () => {
    logShareAccess({
      tenantId: "tenant-1",
      tokenId: "tok-1",
      resourceType: "file",
      resourceId: "file-1",
      action: "unlock",
      success: false,
      failureReason: "wrong_password",
      ipAddress: "203.0.113.7",
    });
    await vi.waitFor(() => expect(calls.filter((c) => c.op === "insert")).toHaveLength(1));
    const row = calls.find((c) => c.op === "insert")!.data as Record<string, unknown>;
    expect(row).toMatchObject({
      action: "unlock",
      success: false,
      failureReason: "wrong_password",
      ipAddress: "203.0.113.7",
    });
  });

  it("truncates a pathological user agent to 500 characters", async () => {
    logShareAccess({
      tenantId: "tenant-1",
      tokenId: "tok-1",
      resourceType: "file",
      resourceId: "file-1",
      action: "resolve",
      userAgent: "U".repeat(5000),
    });
    await vi.waitFor(() => expect(calls.filter((c) => c.op === "insert")).toHaveLength(1));
    const row = calls.find((c) => c.op === "insert")!.data as Record<string, unknown>;
    expect((row.userAgent as string).length).toBe(500);
  });

  /**
   * The logger is void-called from public routes. A failing logger must not
   * reject into an unhandled rejection or deny content to the guest.
   */
  it("swallows a logger failure instead of rejecting", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // A getter that throws when the row is assembled stands in for the insert
    // failing — the point is that the throw happens inside the fire-and-forget
    // IIFE, where an unhandled rejection would otherwise escape.
    logShareAccess({
      tenantId: "tenant-1",
      tokenId: "tok-1",
      resourceType: "file",
      resourceId: "file-1",
      action: "resolve",
      get userAgent(): string {
        throw new Error("access log table is gone");
      },
    } as never);

    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn.mock.calls[0][0]).toContain("share access log failed");
    warn.mockRestore();
  });
});

describe("listShareTokenAccess", () => {
  const accessRow = {
    id: "acc-1",
    tenantId: "tenant-1",
    tokenId: "tok-1",
    resourceType: "file",
    resourceId: "file-1",
    action: "download",
    success: true,
    failureReason: null,
    fileId: "file-1",
    ipAddress: "203.0.113.7",
    userAgent: "curl",
    createdAt: "2026-02-01T00:00:00.000Z",
  };

  it("scopes to both tenant and token", async () => {
    tableResults["share_token_access"] = { data: [], error: null };
    await listShareTokenAccess("tenant-1", "tok-1");
    expect(filtersFor("share_token_access", "select")).toMatchObject({
      tenantId: "tenant-1",
      tokenId: "tok-1",
    });
  });

  it("resolves a friendly file name for rows that name a file", async () => {
    tableResults["share_token_access"] = { data: [accessRow], error: null };
    tableResults["files"] = { data: [{ id: "file-1", name: "bracket.sldprt" }], error: null };
    const rows = await listShareTokenAccess("tenant-1", "tok-1");
    expect(rows[0].fileName).toBe("bracket.sldprt");
  });

  it("leaves fileName null when the file has since been hard-deleted", async () => {
    tableResults["share_token_access"] = { data: [accessRow], error: null };
    tableResults["files"] = { data: [], error: null };
    const rows = await listShareTokenAccess("tenant-1", "tok-1");
    expect(rows[0].fileName).toBeNull();
  });

  it("leaves fileName null for rows with no fileId, and skips the join entirely", async () => {
    tableResults["share_token_access"] = {
      data: [{ ...accessRow, fileId: null, action: "resolve" }],
      error: null,
    };
    const rows = await listShareTokenAccess("tenant-1", "tok-1");
    expect(rows[0].fileName).toBeNull();
    expect(calls.some((c) => c.table === "files")).toBe(false);
  });

  it("clamps the page size into 1..100", async () => {
    tableResults["share_token_access"] = { data: [], error: null };
    // The clamp is not observable through the mock's filters, so assert it
    // does not throw and still returns cleanly at each boundary.
    for (const limit of [-5, 0, 1, 50, 100, 5000]) {
      await expect(listShareTokenAccess("tenant-1", "tok-1", { limit })).resolves.toEqual([]);
    }
  });

  it("applies the cursor as an exclusive upper bound on createdAt", async () => {
    tableResults["share_token_access"] = { data: [], error: null };
    await listShareTokenAccess("tenant-1", "tok-1", { before: "2026-02-01T00:00:00.000Z" });
    expect(filtersFor("share_token_access", "select")["createdAt<"]).toBe(
      "2026-02-01T00:00:00.000Z"
    );
  });

  it("throws when the query errors", async () => {
    tableResults["share_token_access"] = { data: null, error: { message: "denied" } };
    await expect(listShareTokenAccess("tenant-1", "tok-1")).rejects.toMatchObject({
      message: "denied",
    });
  });
});

afterEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
});
