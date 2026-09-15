import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Permanent deletion is the most destructive operation in this application and
 * the only one with no undo, so the tests are mostly about what it refuses and
 * about the order it does things in.
 *
 * The order is the one that shipped wrong. Storage used to go first, so a file
 * an ECO still listed — `eco_items_fileId_fkey` is ON DELETE RESTRICT — lost
 * its stored contents and its version rows, and only then did the row delete
 * fail. Now everything that would refuse or be broken by the delete is checked
 * before anything is touched, the database goes first, and storage is only
 * removed once the row is provably gone.
 */

const { tableResults, readFilters, ops, storage, mockFrom, mockStorage } = vi.hoisted(() => {
  type QueryResult = { data: unknown; error: unknown };
  const tableResults: Record<string, QueryResult> = {};
  /** The filters each table's last read was issued with. */
  const readFilters: Record<string, Record<string, unknown>> = {};
  /** Every destructive step, in the order it ran. */
  const ops: string[] = [];
  const storage = {
    removed: [] as string[][],
    error: null as { message: string } | null,
  };

  function makeChain(table: string) {
    const filters: Record<string, unknown> = {};
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    const resolvable = () => {
      readFilters[table] = { ...filters };
      return tableResults[table] ?? { data: null, error: null };
    };
    for (const m of ["select", "eq", "in", "is", "not", "contains", "order", "limit"] as const)
      chain[m] = (...args: unknown[]) => {
        if (m === "eq" || m === "contains") filters[`${m}:${args[0] as string}`] = args[1];
        if (m === "not") filters[`not:${args[0] as string}`] = args.slice(1);
        return chain;
      };
    chain.single = () => resolvable();
    chain.maybeSingle = () => resolvable();
    chain.delete = () => {
      const deleteFilters: Record<string, unknown> = {};
      const d: Record<string, (...a: unknown[]) => unknown> = {};
      d.eq = (col: unknown, val: unknown) => ((deleteFilters[`eq:${col as string}`] = val), d);
      d.not = (col: unknown, ...rest: unknown[]) => (
        (deleteFilters[`not:${col as string}`] = rest),
        d
      );
      d.select = () => d;
      d.then = ((r: (v: unknown) => void) => {
        ops.push(`delete:${table}`);
        readFilters[`${table}:delete`] = deleteFilters;
        const configured = tableResults[`${table}:delete`];
        r({
          data: configured ? configured.data : [{ id: "deleted" }],
          error: configured?.error ?? null,
        });
      }) as never;
      return d;
    };
    chain.then = ((r: (v: unknown) => void) => r(resolvable())) as never;
    return chain;
  }

  const mockStorage = {
    from: () => ({
      remove: (keys: string[]) => {
        ops.push("storage:remove");
        storage.removed.push(keys);
        return Promise.resolve({ data: null, error: storage.error });
      },
    }),
  };

  return {
    tableResults,
    readFilters,
    ops,
    storage,
    mockFrom: (t: string) => makeChain(t),
    mockStorage,
  };
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
  ops.length = 0;
  storage.removed.length = 0;
  storage.error = null;
  for (const k of Object.keys(tableResults)) delete tableResults[k];
  for (const k of Object.keys(readFilters)) delete readFilters[k];
  tableResults.files = { data: deletedFile, error: null };
  tableResults.file_versions = {
    data: [
      { id: "v1", storageKey: "vault/t1/f1/v1", ecoId: null },
      { id: "v2", storageKey: "vault/t1/f1/v2", ecoId: null },
    ],
    error: null,
  };
  tableResults.eco_items = { data: [], error: null };
  tableResults.releases = { data: [], error: null };
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
    expect(ops).toHaveLength(0);
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
    expect(ops).toHaveLength(0);
  });
});

/**
 * The shipped defect: a file an ECO still listed lost its bytes and versions
 * before the RESTRICT foreign key refused the row delete. Each refusal here
 * must leave storage and every row untouched.
 */
describe("DELETE /api/files/[fileId]/purge — what refuses it, before anything is touched", () => {
  it("refuses a file an ECO lists, naming the ECO", async () => {
    tableResults.eco_items = { data: [{ ecoId: "eco-12" }], error: null };
    tableResults.ecos = { data: [{ id: "eco-12", ecoNumber: "ECO-0012" }], error: null };

    const res = await DELETE(req(), { params });

    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error).toContain("listed on ECO-0012");
    expect(error).toMatch(/nothing was deleted/i);
    expect(ops).toHaveLength(0);
    expect(logAudit).not.toHaveBeenCalled();
  });

  /**
   * A file released through a part it is linked to never appears on
   * eco_items, so the RESTRICT key would not stop it — but implement_eco
   * stamped the version it released, and the release manifest holds that
   * version's storage key.
   */
  it("refuses a file whose version an ECO released", async () => {
    tableResults.file_versions = {
      data: [{ id: "v1", storageKey: "vault/t1/f1/v1", ecoId: "eco-7" }],
      error: null,
    };
    tableResults.ecos = { data: [{ id: "eco-7", ecoNumber: "ECO-0007" }], error: null };

    const res = await DELETE(req(), { params });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("released under ECO-0007");
    expect(ops).toHaveLength(0);
  });

  it("refuses a file a release manifest contains, looked up in the caller's tenant", async () => {
    tableResults.releases = { data: [{ ecoId: "eco-3", ecoNumber: "ECO-0003" }], error: null };

    const res = await DELETE(req(), { params });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("released under ECO-0003");
    expect(readFilters.releases).toMatchObject({
      "eq:tenantId": "tenant-1",
      "contains:manifest": { files: [{ fileId: FILE_ID }] },
    });
    expect(ops).toHaveLength(0);
  });

  it("fails closed when it cannot check what refers to the file", async () => {
    tableResults.eco_items = { data: null, error: { message: "statement timeout" } };

    const res = await DELETE(req(), { params });

    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("statement timeout");
    expect(ops).toHaveLength(0);
  });

  it("fails closed when it cannot read the versions it would need to remove", async () => {
    tableResults.file_versions = { data: null, error: { message: "connection reset" } };

    const res = await DELETE(req(), { params });

    expect(res.status).toBe(500);
    expect(ops).toHaveLength(0);
  });
});

describe("DELETE /api/files/[fileId]/purge — what it destroys, and in what order", () => {
  it("deletes the file row, then removes every version's stored blob", async () => {
    await DELETE(req(), { params });
    expect(ops).toEqual(["delete:files", "storage:remove"]);
    expect(storage.removed).toEqual([["vault/t1/f1/v1", "vault/t1/f1/v2"]]);
  });

  /**
   * One statement. Two — versions, then the file — is how a failure between
   * them left a trashed file with no versions.
   */
  it("deletes only the files row, letting the version rows cascade", async () => {
    await DELETE(req(), { params });
    expect(ops.filter((op) => op.startsWith("delete:"))).toEqual(["delete:files"]);
  });

  it("only deletes a row that is still in the trash, in the caller's tenant", async () => {
    await DELETE(req(), { params });
    expect(readFilters["files:delete"]).toMatchObject({
      "eq:tenantId": "tenant-1",
      "eq:id": FILE_ID,
      "not:deletedAt": ["is", null],
    });
  });

  it("copes with a file that has no versions", async () => {
    tableResults.file_versions = { data: [], error: null };
    expect((await DELETE(req(), { params })).status).toBe(200);
    // Nothing to remove, so storage is not called at all.
    expect(ops).toEqual(["delete:files"]);
  });

  it("skips version rows that carry no storage key", async () => {
    tableResults.file_versions = {
      data: [
        { id: "v1", storageKey: null, ecoId: null },
        { id: "v2", storageKey: "vault/t1/f1/v2", ecoId: null },
      ],
      error: null,
    };
    await DELETE(req(), { params });
    expect(storage.removed).toEqual([["vault/t1/f1/v2"]]);
  });

  it("removes a key shared by a restored version once", async () => {
    tableResults.file_versions = {
      data: [
        { id: "v1", storageKey: "vault/t1/f1/v1", ecoId: null },
        { id: "v2", storageKey: "vault/t1/f1/v1", ecoId: null },
      ],
      error: null,
    };
    await DELETE(req(), { params });
    expect(storage.removed).toEqual([["vault/t1/f1/v1"]]);
  });
});

describe("DELETE /api/files/[fileId]/purge — a failure never costs the stored contents", () => {
  /**
   * The important one. The row delete is what can be refused, and it now runs
   * before storage is touched: a refusal leaves the file whole in the trash.
   */
  it("leaves storage untouched when the file row cannot be deleted", async () => {
    tableResults["files:delete"] = { data: null, error: { message: "still referenced" } };

    const res = await DELETE(req(), { params });

    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error).toContain("still referenced");
    expect(error).toMatch(/still in the trash/i);
    expect(storage.removed).toHaveLength(0);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("leaves storage untouched when the file left the trash before the delete", async () => {
    tableResults["files:delete"] = { data: [], error: null };

    const res = await DELETE(req(), { params });

    expect(res.status).toBe(409);
    expect(storage.removed).toHaveLength(0);
    expect(logAudit).not.toHaveBeenCalled();
  });

  /**
   * The record is already gone by then, so failing the request would report a
   * purge that happened as one that did not. The orphaned keys go on the audit
   * row so they can be cleaned up.
   */
  it("completes, and records the orphaned keys, when storage removal fails afterwards", async () => {
    storage.error = { message: "bucket unavailable" };

    const res = await DELETE(req(), { params });

    expect(res.status).toBe(200);
    expect((await res.json()).warnings?.[0]).toContain("bucket unavailable");
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "file.purge",
        details: expect.objectContaining({
          storageObjectsDestroyed: 0,
          storageRemovalError: "bucket unavailable",
          orphanedStorageKeys: JSON.stringify(["vault/t1/f1/v1", "vault/t1/f1/v2"]),
        }),
      })
    );
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
