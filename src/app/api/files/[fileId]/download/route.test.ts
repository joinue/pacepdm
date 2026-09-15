import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * What name a downloaded file is saved under.
 *
 * Storage keys are `<tenant>/<folder>/<ms>-<name>`. A signed URL without the
 * `download` option carries no Content-Disposition, so the browser named the
 * file after the key: `1726000000000-Bracket.SLDPRT`. Parts downloaded one at
 * a time then no longer matched the names their assemblies reference.
 */

const { rows, signCalls, mockFrom, mockStorage } = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const rows: Record<string, Row[]> = {};
  const signCalls: { key: string; expiresIn: number; opts?: { download?: string } }[] = [];

  function makeChain(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    chain.select = () => chain;
    chain.eq = (col: unknown, val: unknown) => {
      filters.push((r) => r[col as string] === val);
      return chain;
    };
    chain.single = () => {
      const match = (rows[table] ?? []).find((r) => filters.every((f) => f(r)));
      return Promise.resolve({ data: match ?? null, error: null });
    };
    return chain;
  }

  const mockStorage = {
    from: () => ({
      createSignedUrl: (key: string, expiresIn: number, opts?: { download?: string }) => {
        signCalls.push({ key, expiresIn, opts });
        return Promise.resolve({ data: { signedUrl: "https://storage.test/signed" }, error: null });
      },
    }),
  };

  return { rows, signCalls, mockFrom: (t: string) => makeChain(t), mockStorage };
});

vi.mock("@/lib/db", () => ({ getServiceClient: () => ({ from: mockFrom, storage: mockStorage }) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/auth", () => ({
  getApiTenantUser: () =>
    Promise.resolve({ id: "user-1", tenantId: "tenant-1", role: { permissions: ["*"] } }),
}));
vi.mock("@/lib/folder-access-guards", () => ({
  requireFileAccess: () => Promise.resolve({ ok: true }),
}));

import { GET } from "./route";

function download(query = "") {
  return GET(new NextRequest(`http://localhost/api/files/file-1/download${query}`), {
    params: Promise.resolve({ fileId: "file-1" }),
  });
}

beforeEach(() => {
  signCalls.length = 0;
  rows.files = [
    {
      id: "file-1",
      tenantId: "tenant-1",
      folderId: "folder-1",
      name: "Bracket.SLDPRT",
      currentVersion: 2,
      deletedAt: null,
    },
  ];
  rows.file_versions = [
    { fileId: "file-1", version: 1, storageKey: "tenant-1/folder-1/1726000000000-Bracket.SLDPRT" },
    { fileId: "file-1", version: 2, storageKey: "tenant-1/folder-1/1726100000000-Bracket.SLDPRT" },
  ];
});

describe("file download", () => {
  it("signs the current version under the file's own name", async () => {
    const res = await download();

    expect(res.status).toBe(200);
    expect(signCalls).toEqual([
      {
        key: "tenant-1/folder-1/1726100000000-Bracket.SLDPRT",
        expiresIn: 60,
        opts: { download: "Bracket.SLDPRT" },
      },
    ]);
  });

  it("names an older version after the file too, not after its storage key", async () => {
    await download("?version=1");

    expect(signCalls[0]).toMatchObject({
      key: "tenant-1/folder-1/1726000000000-Bracket.SLDPRT",
      opts: { download: "Bracket.SLDPRT" },
    });
  });

  it("404s a file in another tenant without signing anything", async () => {
    rows.files = [{ ...rows.files[0], tenantId: "tenant-2" }];

    const res = await download();

    expect(res.status).toBe(404);
    expect(signCalls).toHaveLength(0);
  });
});
