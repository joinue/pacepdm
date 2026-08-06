import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Permanent deletion is the most destructive operation in this application and
 * the only one with no undo, so the tests are mostly about what it refuses and
 * about the order it does things in.
 *
 * The order matters more than it looks. Storage goes first: if the blobs are
 * removed and a later step fails, the file is broken but visible and can be
 * purged again. If the rows went first and storage failed, the blobs would be
 * orphaned with nothing pointing at them — unrecoverable *and* invisible,
 * which is the one outcome worth engineering against.
 */

const { tableResults, deletes, storage, mockFrom, mockStorage } = vi.hoisted(() => {
  type QueryResult = { data: unknown; error: unknown };
  const tableResults: Record<string, QueryResult> = {};
  const deletes: string[] = [];
  const storage = {
    removed: [] as string[][],
    error: null as { message: string } | null,
  };

  function makeChain(table: string) {
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    const resolvable = () => tableResults[table] ?? { data: null, error: null };
    for (const m of ["select", "eq", "in", "is", "not", "order", "limit"] as const)
      chain[m] = () => chain;
    chain.single = () => resolvable();
    chain.maybeSingle = () => resolvable();
    chain.delete = () => {
      deletes.push(table);
      const d: Record<string, (...a: unknown[]) => unknown> = {};
      d.eq = () => d;
      d.then = ((r: (v: unknown) => void) =>
        r({ data: null, error: tableResults[`${table}:delete`]?.error ?? null })) as never;
      return d;
    };
    chain.then = ((r: (v: unknown) => void) => r(resolvable())) as never;
    return chain;
  }

  const mockStorage = {
    from: () => ({
      remove: (keys: string[]) => {
        storage.removed.push(keys);
        return Promise.resolve({ data: null, error: storage.error });
      },
    }),
  };

  return { tableResults, deletes, storage, mockFrom: (t: string) => makeChain(t), mockStorage };
});

const mockTenantUser = vi.hoisted(() => ({
  current: null as {
    id: string;
    tenantId: string;
    fullName: string;
    role: { permissions: string[] };
  } | null,
}));

vi.mock("@/lib/db", () => ({
  getServiceClient: () => ({ from: mockFrom, storage: mockStorage }),
}));
vi.mock("@/lib/auth", () => ({
  getApiTenantUser: () => Promise.resolve(mockTenantUser.current),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
// The ACL resolver is stubbed open; `loadDeletedFile` itself runs for real, so
// the tenant filter and the deleted-only filter it applies are under test.
vi.mock("@/lib/folder-access", async () => {
  const actual = await vi.importActual<typeof import("@/lib/folder-access")>("@/lib/folder-access");
  return { ...actual, getFolderAccessScope: vi.fn(async () => actual.openScope()) };
});

import { DELETE } from "./route";
import { logAudit } from "@/lib/audit";

const FILE_ID = "55555555-5555-4555-8555-555555555555";
const params = Promise.resolve({ fileId: FILE_ID });

function req(): NextRequest {
  return new NextRequest(`http://localhost/api/files/${FILE_ID}/purge`, { method: "DELETE" });
}

const admin = {
  id: "user-1",
  tenantId: "tenant-1",
  fullName: "Alice",
  role: { permissions: ["*"] },
};

const manager = {
  id: "user-2",
  tenantId: "tenant-1",
  fullName: "Bob",
  // Holds delete — can move a file to the trash — but not purge.
  role: { permissions: ["file.view", "file.edit", "file.delete"] },
};

const deletedFile = {
  id: FILE_ID,
  name: "bracket.sldprt",
  folderId: "folder-1",
  tenantId: "tenant-1",
  deletedAt: "2026-08-01T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  deletes.length = 0;
  storage.removed.length = 0;
  storage.error = null;
  for (const k of Object.keys(tableResults)) delete tableResults[k];
  tableResults.files = { data: deletedFile, error: null };
  tableResults.file_versions = {
    data: [
      { id: "v1", storageKey: "vault/t1/f1/v1" },
      { id: "v2", storageKey: "vault/t1/f1/v2" },
    ],
    error: null,
  };
  mockTenantUser.current = admin;
});

describe("DELETE /api/files/[fileId]/purge — who may", () => {
  it("401s without a session", async () => {
    mockTenantUser.current = null;
    expect((await DELETE(req(), { params })).status).toBe(401);
  });

  /**
   * FILE_DELETE moves a file to the trash and is reversible; Manager holds it.
   * Destroying the file is a different act and Manager must not reach it.
   */
  it("403s a user who can delete but not purge", async () => {
    mockTenantUser.current = manager;
    expect((await DELETE(req(), { params })).status).toBe(403);
  });

  it("allows an admin, who holds it through the wildcard", async () => {
    expect((await DELETE(req(), { params })).status).toBe(200);
  });

  it("400s a malformed file id before touching anything", async () => {
    const res = await DELETE(req(), { params: Promise.resolve({ fileId: "not-a-uuid" }) });
    expect(res.status).toBe(400);
    expect(deletes).toHaveLength(0);
    expect(storage.removed).toHaveLength(0);
  });

  /**
   * `loadDeletedFile` resolves only rows with `deletedAt` set, so a live file
   * cannot be purged. Deletion always has to happen first, which makes the
   * destruction two separate decisions rather than one click.
   */
  it("404s a file that is not in the trash", async () => {
    tableResults.files = { data: null, error: null };
    const res = await DELETE(req(), { params });
    expect(res.status).toBe(404);
    expect(deletes).toHaveLength(0);
    expect(storage.removed).toHaveLength(0);
  });
});

describe("DELETE /api/files/[fileId]/purge — what it destroys", () => {
  it("removes every version's stored blob, then the rows", async () => {
    await DELETE(req(), { params });
    expect(storage.removed).toEqual([["vault/t1/f1/v1", "vault/t1/f1/v2"]]);
    expect(deletes).toEqual(["file_versions", "files"]);
  });

  it("deletes the version rows before the file row", async () => {
    await DELETE(req(), { params });
    expect(deletes.indexOf("file_versions")).toBeLessThan(deletes.indexOf("files"));
  });

  it("copes with a file that has no versions", async () => {
    tableResults.file_versions = { data: [], error: null };
    expect((await DELETE(req(), { params })).status).toBe(200);
    // Nothing to remove, so storage is not called at all.
    expect(storage.removed).toHaveLength(0);
    expect(deletes).toEqual(["file_versions", "files"]);
  });

  it("skips version rows that carry no storage key", async () => {
    tableResults.file_versions = {
      data: [
        { id: "v1", storageKey: null },
        { id: "v2", storageKey: "vault/t1/f1/v2" },
      ],
      error: null,
    };
    await DELETE(req(), { params });
    expect(storage.removed).toEqual([["vault/t1/f1/v2"]]);
  });
});

describe("DELETE /api/files/[fileId]/purge — failure leaves the file recoverable", () => {
  /**
   * The important one. Storage runs first precisely so this branch can stop
   * before anything is unrecoverable: the file stays in the trash, whole.
   */
  it("deletes no rows when storage removal fails", async () => {
    storage.error = { message: "bucket unavailable" };
    const res = await DELETE(req(), { params });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/still in the trash/i);
    expect(deletes).toHaveLength(0);
  });

  it("does not delete the file row when the version rows fail to go", async () => {
    tableResults["file_versions:delete"] = { data: null, error: { message: "fk violation" } };
    const res = await DELETE(req(), { params });

    expect(res.status).toBe(409);
    expect(deletes).toEqual(["file_versions"]);
    // The message has to say the file is now incomplete, because it is.
    expect((await res.json()).error).toMatch(/incomplete/i);
  });

  it("surfaces a failure to delete the file row", async () => {
    tableResults["files:delete"] = { data: null, error: { message: "still referenced" } };
    const res = await DELETE(req(), { params });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("still referenced");
  });

  it("writes no audit row when the purge did not complete", async () => {
    storage.error = { message: "bucket unavailable" };
    await DELETE(req(), { params });
    expect(logAudit).not.toHaveBeenCalled();
  });
});

/**
 * The audit row is the only surviving trace. A permanent deletion that erased
 * its own evidence would be worse than no permanent deletion at all — audit
 * rows are append-only and this route never touches them.
 */
describe("DELETE /api/files/[fileId]/purge — the record that outlives the file", () => {
  it("records the name, the actor and what was destroyed", async () => {
    await DELETE(req(), { params });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        userId: "user-1",
        action: "file.purge",
        entityType: "file",
        entityId: FILE_ID,
        details: expect.objectContaining({
          name: "bracket.sldprt",
          versionsDestroyed: 2,
          storageObjectsDestroyed: 2,
        }),
      })
    );
  });

  it("returns the name so the UI can confirm what went", async () => {
    const body = await (await DELETE(req(), { params })).json();
    expect(body).toEqual({ success: true, name: "bracket.sldprt" });
  });
});
