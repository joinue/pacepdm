import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The content endpoint is where a share link actually hands data to a
 * stranger, so the suite covers three things:
 *
 *   - The password gate. A gated link must refuse without a valid unlock
 *     cookie, and a cookie minted for another share must not work.
 *   - Tenant scoping on every resource read. These handlers use the raw
 *     service client, so nothing applies the filter for them.
 *   - What each resource kind does and does not put in the payload —
 *     particularly the part branch, which must not tell a supplier that
 *     unreleased drawings exist.
 *
 * `@/lib/share-tokens` is not mocked: `resolveToken` and `verifyUnlockCookie`
 * run for real so the gate is under test rather than stubbed open.
 */

const { tableResults, signedUrls, mockFrom, mockStorage } = vi.hoisted(() => {
  type QueryResult = { data: unknown; error: unknown };
  type Handler = QueryResult | ((filters: Record<string, unknown>) => QueryResult);

  const tableResults: Record<string, Handler> = {};
  const signedUrls: { result: { data: unknown; error: unknown }; calls: string[] } = {
    result: { data: { signedUrl: "https://storage.test/signed" }, error: null },
    calls: [],
  };

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

  const mockStorage = {
    from: () => ({
      createSignedUrl: (key: string) => {
        signedUrls.calls.push(key);
        return Promise.resolve(signedUrls.result);
      },
    }),
  };

  return { tableResults, signedUrls, mockFrom: (t: string) => makeChain(t), mockStorage };
});

const { releaseResult, packageResult } = vi.hoisted(() => ({
  releaseResult: { current: null as unknown },
  packageResult: { current: null as unknown },
}));

vi.mock("@/lib/db", () => ({
  getServiceClient: () => ({ from: mockFrom, storage: mockStorage }),
}));

vi.mock("@/lib/releases", () => ({
  getReleaseById: vi.fn(async () => releaseResult.current),
}));

vi.mock("@/lib/part-package", () => ({
  buildPartPackage: vi.fn(async () => packageResult.current),
}));

import { GET } from "./route";
import { unlockCookieName, unlockCookieValue, hashPassword } from "@/lib/share-tokens";
import { buildPartPackage } from "@/lib/part-package";

const TOKEN = "vJk3nQ7pR2sT5uW8xY1zA4bC6dE9fG0h";

let ipCounter = 0;
function makeRequest(opts: { cookie?: string; ip?: string } = {}): NextRequest {
  const headers: Record<string, string> = {
    "x-forwarded-for": opts.ip ?? `10.2.0.${++ipCounter % 250}`,
  };
  if (opts.cookie) headers.cookie = opts.cookie;
  return new NextRequest(`http://localhost/api/public/share/${TOKEN}/content`, { headers });
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

function givenToken(overrides: Record<string, unknown> = {}) {
  tableResults["share_tokens"] = { data: { ...baseToken, ...overrides }, error: null };
}

const pdfFile = {
  id: "file-1",
  tenantId: "tenant-1",
  name: "drawing.pdf",
  fileType: "pdf",
  currentVersion: 3,
  thumbnailKey: null,
};

/** Serve `row` from `files` only to the tenant that owns it. */
function givenFile(row: Record<string, unknown>, ownerTenant = "tenant-1") {
  tableResults["files"] = (filters) =>
    filters.tenantId === ownerTenant ? { data: row, error: null } : { data: null, error: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(tableResults)) delete tableResults[key];
  signedUrls.result = { data: { signedUrl: "https://storage.test/signed" }, error: null };
  signedUrls.calls.length = 0;
  releaseResult.current = null;
  packageResult.current = null;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  tableResults["file_versions"] = { data: { storageKey: "vault/tenant-1/file-1/v3" }, error: null };
});

// ── Token state ─────────────────────────────────────────────────────────────

describe("token state", () => {
  it("404s a token that matches nothing", async () => {
    tableResults["share_tokens"] = { data: null, error: null };
    const res = await GET(makeRequest(), { params });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });

  it("404s a revoked link and names the reason", async () => {
    givenToken({ revokedAt: "2026-02-01T00:00:00.000Z" });
    givenFile(pdfFile);
    const res = await GET(makeRequest(), { params });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("revoked");
  });

  it("404s an expired link and names the reason", async () => {
    givenToken({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    givenFile(pdfFile);
    const res = await GET(makeRequest(), { params });
    expect((await res.json()).error).toBe("expired");
  });

  it("marks every response noindex", async () => {
    givenToken();
    givenFile(pdfFile);
    expect((await GET(makeRequest(), { params })).headers.get("X-Robots-Tag")).toBe(
      "noindex, nofollow"
    );
    tableResults["share_tokens"] = { data: null, error: null };
    expect((await GET(makeRequest(), { params })).headers.get("X-Robots-Tag")).toBe(
      "noindex, nofollow"
    );
  });
});

// ── Password gate ───────────────────────────────────────────────────────────

describe("password gate", () => {
  beforeEach(async () => {
    givenToken({ passwordHash: await hashPassword("hunter2") });
    givenFile(pdfFile);
  });

  it("401s a gated link with no cookie at all", async () => {
    const res = await GET(makeRequest(), { params });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("password_required");
  });

  it("401s a gated link with a forged cookie value", async () => {
    const res = await GET(makeRequest({ cookie: `${unlockCookieName(TOKEN)}=forged` }), {
      params,
    });
    expect(res.status).toBe(401);
  });

  /**
   * The cookie is an HMAC over the token, so unlocking one share must not
   * unlock another. This is the assertion that would catch a refactor to a
   * constant or session-wide cookie value.
   */
  it("401s a cookie that was minted for a different share", async () => {
    const otherValue = unlockCookieValue("some-entirely-different-token");
    const res = await GET(makeRequest({ cookie: `${unlockCookieName(TOKEN)}=${otherValue}` }), {
      params,
    });
    expect(res.status).toBe(401);
  });

  it("serves content once the correct unlock cookie is present", async () => {
    const cookie = `${unlockCookieName(TOKEN)}=${unlockCookieValue(TOKEN)}`;
    const res = await GET(makeRequest({ cookie }), { params });
    expect(res.status).toBe(200);
    expect((await res.json()).kind).toBe("file");
  });

  it("does not sign a storage URL before the gate passes", async () => {
    await GET(makeRequest(), { params });
    expect(signedUrls.calls).toHaveLength(0);
  });
});

// ── File shares ─────────────────────────────────────────────────────────────

describe("file shares", () => {
  it("404s when the file belongs to another tenant", async () => {
    givenToken();
    givenFile(pdfFile, "tenant-OTHER");
    const res = await GET(makeRequest(), { params });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });

  it("returns a pdf as a previewable pdf with a signed URL", async () => {
    givenToken();
    givenFile(pdfFile);
    const body = await (await GET(makeRequest(), { params })).json();
    expect(body).toMatchObject({
      kind: "file",
      fileName: "drawing.pdf",
      canPreview: true,
      previewType: "pdf",
      url: "https://storage.test/signed",
    });
  });

  it.each([
    ["png", "image"],
    ["jpeg", "image"],
    ["svg", "image"],
    ["txt", "text"],
    ["csv", "text"],
    ["json", "text"],
    ["stl", "cad"],
    ["step", "cad"],
    ["igs", "cad"],
  ])("maps .%s to the %s preview", async (ext, expected) => {
    givenToken();
    givenFile({ ...pdfFile, name: `part.${ext}`, fileType: ext });
    const body = await (await GET(makeRequest(), { params })).json();
    expect(body.previewType).toBe(expected);
  });

  it("falls back to the extension in the name when fileType is empty", async () => {
    givenToken();
    givenFile({ ...pdfFile, name: "model.STEP", fileType: null });
    const body = await (await GET(makeRequest(), { params })).json();
    expect(body).toMatchObject({ canPreview: true, previewType: "cad", fileType: "step" });
  });

  /**
   * SolidWorks natives cannot render in a browser, so "preview" means the
   * bitmap extracted at upload. The signed URL points at the thumbnail, not
   * the CAD file — a viewer must not be handed the model itself here.
   */
  it("serves the extracted thumbnail for a SolidWorks file", async () => {
    givenToken();
    givenFile({
      ...pdfFile,
      name: "bracket.sldprt",
      fileType: "sldprt",
      thumbnailKey: "vault/thumbs/bracket.png",
    });
    const body = await (await GET(makeRequest(), { params })).json();
    expect(body).toMatchObject({ canPreview: true, previewType: "image", fileType: "sldprt" });
    expect(signedUrls.calls).toEqual(["vault/thumbs/bracket.png"]);
  });

  it("treats a SolidWorks file with no thumbnail as unpreviewable", async () => {
    givenToken({ allowDownload: false });
    givenFile({ ...pdfFile, name: "bracket.sldasm", fileType: "sldasm", thumbnailKey: null });
    const body = await (await GET(makeRequest(), { params })).json();
    expect(body).toMatchObject({ canPreview: false, fileType: "sldasm" });
    expect(body.url).toBeUndefined();
  });

  /**
   * An unpreviewable type still returns a payload so the viewer can render
   * metadata and a download button — but the signed URL only appears when the
   * link actually permits downloads.
   */
  it("withholds the URL for an unpreviewable file when downloads are off", async () => {
    givenToken({ allowDownload: false });
    givenFile({ ...pdfFile, name: "archive.zip", fileType: "zip" });
    const body = await (await GET(makeRequest(), { params })).json();
    expect(body).toMatchObject({ canPreview: false, allowDownload: false });
    expect(body.url).toBeUndefined();
    expect(signedUrls.calls).toHaveLength(0);
  });

  it("includes the URL for an unpreviewable file when downloads are allowed", async () => {
    givenToken({ allowDownload: true });
    givenFile({ ...pdfFile, name: "archive.zip", fileType: "zip" });
    const body = await (await GET(makeRequest(), { params })).json();
    expect(body).toMatchObject({ canPreview: false, url: "https://storage.test/signed" });
  });

  it("404s when the current version row is missing", async () => {
    givenToken();
    givenFile(pdfFile);
    tableResults["file_versions"] = { data: null, error: null };
    const res = await GET(makeRequest(), { params });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("version_missing");
  });

  it("500s when storage refuses to sign", async () => {
    givenToken();
    givenFile(pdfFile);
    signedUrls.result = { data: null, error: { message: "no such object" } };
    const res = await GET(makeRequest(), { params });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("signing_failed");
  });

  it("signs the storage key of the file's current version", async () => {
    givenToken();
    givenFile(pdfFile);
    await GET(makeRequest(), { params });
    expect(signedUrls.calls).toEqual(["vault/tenant-1/file-1/v3"]);
  });
});

// ── BOM shares ──────────────────────────────────────────────────────────────

describe("bom shares", () => {
  beforeEach(() => {
    givenToken({ resourceType: "bom", resourceId: "bom-1" });
  });

  it("404s when the bom is in another tenant", async () => {
    tableResults["boms"] = (filters) =>
      filters.tenantId === "tenant-OTHER"
        ? { data: { id: "bom-1", name: "Secret" }, error: null }
        : { data: null, error: null };
    expect((await GET(makeRequest(), { params })).status).toBe(404);
  });

  it("returns the flattened item list", async () => {
    tableResults["boms"] = {
      data: { id: "bom-1", name: "Gearbox", revision: "B", status: "RELEASED" },
      error: null,
    };
    tableResults["bom_items"] = {
      data: [
        {
          itemNumber: "1",
          partNumber: "PN-1",
          name: "Housing",
          quantity: 2,
          unit: "ea",
          material: "AL6061",
          vendor: "Acme",
          sortOrder: 1,
        },
      ],
      error: null,
    };
    const body = await (await GET(makeRequest(), { params })).json();
    expect(body).toMatchObject({ kind: "bom", bomName: "Gearbox", revision: "B" });
    expect(body.items).toEqual([
      {
        itemNumber: "1",
        partNumber: "PN-1",
        name: "Housing",
        quantity: 2,
        unit: "ea",
        material: "AL6061",
        vendor: "Acme",
      },
    ]);
  });

  it("returns an empty item list rather than failing on a bom with no items", async () => {
    tableResults["boms"] = { data: { id: "bom-1", name: "Empty" }, error: null };
    tableResults["bom_items"] = { data: null, error: null };
    const body = await (await GET(makeRequest(), { params })).json();
    expect(body.items).toEqual([]);
    expect(body.revision).toBeNull();
  });

  /**
   * `sortOrder` drives the query's ordering but is not part of the public
   * contract — it is an internal column and does not belong in the payload.
   */
  it("does not leak the internal sort column to the viewer", async () => {
    tableResults["boms"] = { data: { id: "bom-1", name: "Gearbox" }, error: null };
    tableResults["bom_items"] = {
      data: [{ itemNumber: "1", partNumber: "PN-1", sortOrder: 7 }],
      error: null,
    };
    const body = await (await GET(makeRequest(), { params })).json();
    expect(body.items[0]).not.toHaveProperty("sortOrder");
  });
});

// ── Release shares ──────────────────────────────────────────────────────────

describe("release shares", () => {
  beforeEach(() => {
    givenToken({ resourceType: "release", resourceId: "rel-1" });
  });

  it("404s when the release cannot be resolved in the token's tenant", async () => {
    releaseResult.current = null;
    expect((await GET(makeRequest(), { params })).status).toBe(404);
  });

  it("returns the release manifest", async () => {
    releaseResult.current = {
      name: "R2026.02",
      ecoNumber: "ECO-0042",
      releasedAt: "2026-02-01T00:00:00.000Z",
      note: "First article",
      manifest: { files: [{ name: "drawing.pdf" }] },
    };
    const body = await (await GET(makeRequest(), { params })).json();
    expect(body).toMatchObject({
      kind: "release",
      releaseName: "R2026.02",
      ecoNumber: "ECO-0042",
      note: "First article",
    });
    expect(body.manifest.files).toHaveLength(1);
  });
});

// ── Part shares ─────────────────────────────────────────────────────────────

describe("part shares", () => {
  const pkg = {
    partNumber: "PN-1042",
    name: "Idler bracket",
    description: "Sheet metal",
    revision: "C",
    lifecycleState: "Released",
    category: "Machined",
    material: "AL6061",
    unit: "ea",
    weight: 0.42,
    weightUnit: "kg",
    files: [
      {
        storageKey: "vault/a.pdf",
        fileName: "a.pdf",
        fileType: "pdf",
        role: "drawing",
        isPrimary: true,
        revision: "C",
        version: 4,
        isPreliminary: false,
      },
    ],
    boms: [{ name: "PN-1042 BOM", items: [] }],
    preliminaryCount: 0,
    filesWithheld: 0,
  };

  beforeEach(() => {
    givenToken({ resourceType: "part", resourceId: "part-1" });
  });

  it("404s when the part package cannot be built", async () => {
    packageResult.current = null;
    expect((await GET(makeRequest(), { params })).status).toBe(404);
  });

  it("returns part metadata with a signed URL per file", async () => {
    packageResult.current = pkg;
    const body = await (await GET(makeRequest(), { params })).json();
    expect(body).toMatchObject({
      kind: "part",
      partNumber: "PN-1042",
      revision: "C",
      containsPreliminary: false,
    });
    expect(body.files[0]).toMatchObject({
      fileName: "a.pdf",
      isPrimary: true,
      url: "https://storage.test/signed",
    });
  });

  /**
   * The storage key is an internal path that encodes tenant and file ids. The
   * viewer gets a short-lived signed URL instead; the key itself must not
   * appear anywhere in the payload.
   */
  it("hands over a signed URL, never the raw storage key", async () => {
    packageResult.current = pkg;
    const body = await (await GET(makeRequest(), { params })).json();
    expect(JSON.stringify(body)).not.toContain("vault/a.pdf");
    expect(body.files[0]).not.toHaveProperty("storageKey");
  });

  /**
   * `filesWithheld` tells an internal user how many unreleased documents the
   * link is hiding. A supplier has no business learning that they exist —
   * this is the one field whose absence is the point.
   */
  it("does not tell the guest that documents were withheld", async () => {
    packageResult.current = { ...pkg, filesWithheld: 3 };
    const body = await (await GET(makeRequest(), { params })).json();
    expect(body).not.toHaveProperty("filesWithheld");
    expect(JSON.stringify(body)).not.toContain("filesWithheld");
  });

  it("flags a package that contains preliminary documents", async () => {
    packageResult.current = {
      ...pkg,
      preliminaryCount: 2,
      files: [{ ...pkg.files[0], isPreliminary: true }],
    };
    const body = await (await GET(makeRequest(), { params })).json();
    expect(body.containsPreliminary).toBe(true);
    expect(body.files[0].isPreliminary).toBe(true);
  });

  it("passes the link's includeWip setting through to the package builder", async () => {
    packageResult.current = pkg;
    givenToken({ resourceType: "part", resourceId: "part-1", includeWip: true });
    await GET(makeRequest(), { params });
    expect(buildPartPackage).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-1",
      "part-1",
      { includeWip: true }
    );
  });

  it("omits the url for a file storage declined to sign", async () => {
    packageResult.current = pkg;
    signedUrls.result = { data: null, error: { message: "gone" } };
    const body = await (await GET(makeRequest(), { params })).json();
    expect(body.files[0].url).toBeUndefined();
    // The rest of the package still renders — one missing document should not
    // blank the whole page for the supplier.
    expect(body.partNumber).toBe("PN-1042");
  });
});

// ── Failure handling ────────────────────────────────────────────────────────

describe("failure handling", () => {
  it("rate-limits a single IP", async () => {
    tableResults["share_tokens"] = { data: null, error: null };
    const ip = "198.51.100.99";
    let sawLimit = false;
    for (let i = 0; i < 40 && !sawLimit; i++) {
      sawLimit = (await GET(makeRequest({ ip }), { params })).status === 429;
    }
    expect(sawLimit).toBe(true);
  });

  it("500s with the underlying message when a lookup throws", async () => {
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
