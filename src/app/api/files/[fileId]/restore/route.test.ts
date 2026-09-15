import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * A restore is a new version, so while a file's release is under review it
 * would become what the approval releases. These cover that lock; the rest of
 * the route predates its tests.
 */

const { tableResults, writes, mockFrom } = vi.hoisted(() => {
  type QueryResult = { data: unknown; error: unknown };
  const tableResults: Record<string, QueryResult> = {};
  /** Every write, in order: `insert:<table>`, `update:<table>`. */
  const writes: string[] = [];

  function makeChain(table: string) {
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    const resolvable = () => tableResults[table] ?? { data: null, error: null };
    for (const m of ["select", "eq", "in", "is", "not", "order", "limit"] as const)
      chain[m] = () => chain;
    chain.single = () => resolvable();
    chain.maybeSingle = () => resolvable();
    const write = (kind: string) => () => {
      writes.push(`${kind}:${table}`);
      const w: Record<string, (...a: unknown[]) => unknown> = {};
      for (const m of ["eq", "select", "single"] as const) w[m] = () => w;
      w.then = ((r: (v: unknown) => void) => r({ data: null, error: null })) as never;
      return w;
    };
    chain.insert = write("insert");
    chain.update = write("update");
    chain.then = ((r: (v: unknown) => void) => r(resolvable())) as never;
    return chain;
  }

  return { tableResults, writes, mockFrom: (t: string) => makeChain(t) };
});

vi.mock("@/lib/db", () => ({
  getServiceClient: () => ({ from: mockFrom }),
}));
vi.mock("@/lib/auth", () => ({
  getApiTenantUser: () =>
    Promise.resolve({
      id: "user-1",
      tenantId: "tenant-1",
      fullName: "Alice",
      role: { permissions: ["file.checkin"] },
    }),
  hasPermission: (perms: string[], required: string) =>
    perms.includes("*") || perms.includes(required),
  PERMISSIONS: { FILE_CHECKIN: "file.checkin" },
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/folder-access-guards", () => ({
  requireFileAccess: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("uuid", () => ({ v4: () => "mock-uuid" }));

import { POST } from "./route";

const params = Promise.resolve({ fileId: "file-1" });

function req(): NextRequest {
  return new NextRequest("http://localhost/api/files/file-1/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: 1 }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  writes.length = 0;
  for (const k of Object.keys(tableResults)) delete tableResults[k];
  tableResults.files = {
    data: {
      id: "file-1",
      tenantId: "tenant-1",
      name: "bracket.sldprt",
      folderId: "folder-1",
      isFrozen: false,
      isCheckedOut: false,
      currentVersion: 2,
      revision: "A",
      thumbnailKey: null,
    },
    error: null,
  };
  tableResults.file_versions = {
    data: { id: "v1", version: 1, storageKey: "t1/f1/v1", fileSize: 10 },
    error: null,
  };
});

describe("POST /api/files/[fileId]/restore — pending approval", () => {
  it("refuses a restore while a transition on the file is awaiting approval", async () => {
    tableResults.approval_requests = {
      data: [{ id: "req-1", title: "Release: bracket.sldprt" }],
      error: null,
    };

    const res = await POST(req(), { params });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/awaiting approval/i);
    expect(writes).toEqual([]);
  });

  it("restores when nothing is pending", async () => {
    const res = await POST(req(), { params });

    expect(res.status).toBe(200);
    expect(writes).toEqual(["insert:file_versions", "update:files"]);
  });
});
