import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The route treats a file's name as part of the released artifact, so it locks
 * while a release of the file is under review as well as once released. These
 * cover that lock; the rest of the route predates its tests.
 */

const { tableResults, writes, mockFrom } = vi.hoisted(() => {
  type QueryResult = { data: unknown; error: unknown };
  const tableResults: Record<string, QueryResult> = {};
  /** Every write, in order: `update:<table>`. */
  const writes: string[] = [];

  function makeChain(table: string) {
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    const resolvable = () => tableResults[table] ?? { data: null, error: null };
    for (const m of ["select", "eq", "in", "is", "not", "order", "limit"] as const)
      chain[m] = () => chain;
    chain.single = () => resolvable();
    chain.maybeSingle = () => resolvable();
    chain.update = () => {
      writes.push(`update:${table}`);
      const w: Record<string, (...a: unknown[]) => unknown> = {};
      w.eq = () => w;
      w.then = ((r: (v: unknown) => void) => r({ data: null, error: null })) as never;
      return w;
    };
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
      role: { permissions: ["file.edit"] },
    }),
  hasPermission: (perms: string[], required: string) =>
    perms.includes("*") || perms.includes(required),
  PERMISSIONS: { FILE_EDIT: "file.edit" },
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/folder-access-guards", () => ({
  requireFileAccess: vi.fn().mockResolvedValue({ ok: true }),
}));

import { PUT } from "./route";

const params = Promise.resolve({ fileId: "file-1" });

function req(): NextRequest {
  return new NextRequest("http://localhost/api/files/file-1/rename", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "bracket-v2.sldprt" }),
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
    },
    error: null,
  };
});

describe("PUT /api/files/[fileId]/rename — pending approval", () => {
  it("refuses a rename while a transition on the file is awaiting approval", async () => {
    tableResults.approval_requests = {
      data: [{ id: "req-1", title: "Release: bracket.sldprt" }],
      error: null,
    };

    const res = await PUT(req(), { params });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/awaiting approval/i);
    expect(writes).toEqual([]);
  });

  it("renames when nothing is pending", async () => {
    const res = await PUT(req(), { params });

    expect(res.status).toBe(200);
    expect(writes).toEqual(["update:files"]);
  });
});
