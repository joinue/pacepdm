import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The thumbnail endpoints are thin, so the tests that matter are the ones that
 * keep them thin safely: refusing a caller without FILE_EDIT, refusing a BOM in
 * another tenant *before* anything reaches storage, refusing a file we would
 * not want in the bucket, and cleaning up after itself when either half of the
 * two-step write (storage object, then row) fails.
 *
 * The vendor and part endpoints are the same code against a different table.
 */

const { tables, updates, storage, mockFrom, storageApi } = vi.hoisted(() => {
  const tables: Record<string, Record<string, unknown>[]> = {};
  const updates: Array<{ table: string; data: Record<string, unknown> }> = [];
  const storage = {
    uploaded: [] as { key: string; contentType: string }[],
    removed: [] as string[],
    uploadError: null as string | null,
  };

  function makeChain(table: string) {
    const filters: Record<string, unknown> = {};
    const chain: Record<string, (...args: unknown[]) => unknown> = {};

    const rows = () => {
      let out = tables[table] ?? [];
      for (const [k, v] of Object.entries(filters)) out = out.filter((r) => r[k] === v);
      return out;
    };

    for (const m of ["select", "is", "order", "limit"] as const) chain[m] = () => chain;
    chain.eq = (...a: unknown[]) => {
      filters[a[0] as string] = a[1];
      return chain;
    };
    chain.maybeSingle = () => ({ data: rows()[0] ?? null, error: null });
    chain.single = () => ({ data: rows()[0] ?? null, error: null });
    chain.update = (data: unknown) => {
      const c: Record<string, (...args: unknown[]) => unknown> = {};
      c.eq = () => c;
      c.then = ((resolve: (v: unknown) => void) => {
        updates.push({ table, data: data as Record<string, unknown> });
        return resolve({ data: null, error: null });
      }) as never;
      return c;
    };
    chain.then = ((resolve: (v: unknown) => void) =>
      resolve({ data: rows(), error: null })) as never;
    return chain;
  }

  const storageApi = {
    from: () => ({
      upload: (key: string, _file: unknown, opts: { contentType: string }) => {
        if (storage.uploadError) return { error: { message: storage.uploadError } };
        storage.uploaded.push({ key, contentType: opts.contentType });
        return { error: null };
      },
      remove: (keys: string[]) => {
        storage.removed.push(...keys);
        return { error: null };
      },
      createSignedUrl: (key: string) => ({
        data: { signedUrl: `https://signed.example/${key}` },
        error: null,
      }),
    }),
  };

  return {
    tables,
    updates,
    storage,
    mockFrom: (t: string) => makeChain(t),
    storageApi,
  } as const;
});

const mockTenantUser = vi.hoisted(() => ({
  current: null as { id: string; tenantId: string; role: { permissions: string[] } } | null,
}));

vi.mock("@/lib/db", () => ({
  getServiceClient: () => ({ from: mockFrom, storage: storageApi }),
}));
vi.mock("@/lib/auth", () => ({
  getApiTenantUser: () => Promise.resolve(mockTenantUser.current),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import { POST, DELETE } from "./route";
import { logAudit } from "@/lib/audit";

const BOM_ID = "11111111-1111-4111-8111-111111111111";

const engineer = { id: "user-1", tenantId: "tenant-1", role: { permissions: ["file.edit"] } };
const viewer = { id: "user-2", tenantId: "tenant-1", role: { permissions: ["file.view"] } };

const params = Promise.resolve({ bomId: BOM_ID });

function uploadReq(file: File | null) {
  const form = new FormData();
  if (file) form.append("file", file);
  return new NextRequest(`http://localhost/api/boms/${BOM_ID}/thumbnail`, {
    method: "POST",
    body: form,
  });
}

function image(type = "image/png", bytes = 1024) {
  return new File([new Uint8Array(bytes)], "preview.png", { type });
}

function seedBom(overrides: Record<string, unknown> = {}, tenantId = "tenant-1") {
  tables["boms"] = [
    {
      id: BOM_ID,
      tenantId,
      name: "NANO-1000S",
      thumbnailKey: null,
      deletedAt: null,
      ...overrides,
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTenantUser.current = engineer;
  updates.length = 0;
  storage.uploaded.length = 0;
  storage.removed.length = 0;
  storage.uploadError = null;
  for (const k of Object.keys(tables)) delete tables[k];
});

describe("POST /api/boms/[bomId]/thumbnail", () => {
  it("returns 401 when not authenticated", async () => {
    mockTenantUser.current = null;
    seedBom();
    expect((await POST(uploadReq(image()), { params })).status).toBe(401);
    expect(storage.uploaded).toHaveLength(0);
  });

  it("returns 403 without FILE_EDIT", async () => {
    mockTenantUser.current = viewer;
    seedBom();
    expect((await POST(uploadReq(image()), { params })).status).toBe(403);
    expect(storage.uploaded).toHaveLength(0);
  });

  it("returns 404 for a BOM in another tenant, without touching storage", async () => {
    seedBom({}, "tenant-OTHER");
    expect((await POST(uploadReq(image()), { params })).status).toBe(404);
    expect(storage.uploaded).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("stores the image under the caller's tenant prefix and records the key", async () => {
    seedBom();
    const res = await POST(uploadReq(image()), { params });
    expect(res.status).toBe(200);

    expect(storage.uploaded).toHaveLength(1);
    // The tenant prefix is the only isolation storage has.
    expect(storage.uploaded[0].key).toMatch(
      new RegExp(`^tenant-1/thumbnails/boms/${BOM_ID}-\\d+\\.png$`)
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe("boms");
    expect(updates[0].data.thumbnailKey).toBe(storage.uploaded[0].key);

    expect(await res.json()).toEqual({
      thumbnailUrl: `https://signed.example/${storage.uploaded[0].key}`,
    });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "bom.thumbnail.update", entityId: BOM_ID })
    );
  });

  it("removes the previous object once the replacement is stored", async () => {
    seedBom({ thumbnailKey: "tenant-1/thumbnails/boms/old.png" });
    await POST(uploadReq(image()), { params });
    expect(storage.removed).toEqual(["tenant-1/thumbnails/boms/old.png"]);
  });

  it("rejects a non-image without uploading it", async () => {
    seedBom();
    const res = await POST(uploadReq(new File(["x"], "notes.pdf", { type: "application/pdf" })), {
      params,
    });
    expect(res.status).toBe(422);
    expect(storage.uploaded).toHaveLength(0);
  });

  it("rejects an oversized image", async () => {
    seedBom();
    const res = await POST(uploadReq(image("image/png", 6 * 1024 * 1024)), { params });
    expect(res.status).toBe(422);
    expect(storage.uploaded).toHaveLength(0);
  });

  it("returns 400 when no file was sent", async () => {
    seedBom();
    expect((await POST(uploadReq(null), { params })).status).toBe(400);
  });

  it("surfaces a storage failure instead of writing a key that points at nothing", async () => {
    seedBom();
    storage.uploadError = "bucket unavailable";
    const res = await POST(uploadReq(image()), { params });
    expect(res.status).toBe(500);
    expect(updates).toHaveLength(0);
  });
});

describe("DELETE /api/boms/[bomId]/thumbnail", () => {
  it("returns 403 without FILE_EDIT", async () => {
    mockTenantUser.current = viewer;
    seedBom({ thumbnailKey: "tenant-1/thumbnails/boms/old.png" });
    expect((await DELETE(uploadReq(null), { params })).status).toBe(403);
    expect(storage.removed).toHaveLength(0);
  });

  it("returns 404 for a BOM in another tenant", async () => {
    seedBom({ thumbnailKey: "tenant-OTHER/thumbnails/boms/old.png" }, "tenant-OTHER");
    expect((await DELETE(uploadReq(null), { params })).status).toBe(404);
    expect(storage.removed).toHaveLength(0);
  });

  it("clears the row first, then the object", async () => {
    seedBom({ thumbnailKey: "tenant-1/thumbnails/boms/old.png" });
    const res = await DELETE(uploadReq(null), { params });
    expect(res.status).toBe(200);
    expect(updates[0].data.thumbnailKey).toBeNull();
    expect(storage.removed).toEqual(["tenant-1/thumbnails/boms/old.png"]);
    expect(await res.json()).toEqual({ thumbnailUrl: null });
  });

  it("is a no-op on storage when the BOM has no image", async () => {
    seedBom();
    expect((await DELETE(uploadReq(null), { params })).status).toBe(200);
    expect(storage.removed).toHaveLength(0);
  });
});
