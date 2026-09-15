import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Prepare is where a selection that cannot be zipped becomes a sentence the
 * user can act on, before the browser commits to a download. It mints no
 * token any more: its answer is the same few fields for any selection size.
 */

const { state } = vi.hoisted(() => ({
  state: { tenantUser: null as unknown, client: null as unknown },
}));

vi.mock("@/lib/db", () => ({ getServiceClient: () => state.client }));
vi.mock("@/lib/auth", () => ({ getApiTenantUser: () => Promise.resolve(state.tenantUser) }));
vi.mock("@/lib/folder-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/folder-access")>();
  return { ...actual, getFolderAccessScope: vi.fn(() => Promise.resolve(actual.openScope())) };
});

import { POST } from "./route";
import { createFakeVault, type FakeVault } from "@/lib/__mocks__/fake-vault";

const TENANT = "tenant-1";
let vault: FakeVault;

function prepare(fileIds: string[]) {
  return POST(
    new NextRequest("http://localhost/api/files/bulk-download/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileIds }),
    })
  );
}

function seed(count: number, fileSize: number) {
  const ids = Array.from({ length: count }, (_, i) => `f${String(i).padStart(4, "0")}`);
  vault.tables.files = ids.map((id) => ({
    id,
    tenantId: TENANT,
    folderId: "d1",
    name: `${id}.sldprt`,
    currentVersion: 1,
    deletedAt: null,
  }));
  vault.tables.file_versions = ids.map((id) => ({
    id: `${id}-v1`,
    fileId: id,
    version: 1,
    storageKey: `${TENANT}/${id}`,
    fileSize,
  }));
  return ids;
}

beforeEach(() => {
  vault = createFakeVault();
  state.client = vault.client;
  state.tenantUser = {
    id: "user-1",
    tenantId: TENANT,
    roleId: "role-1",
    role: { id: "role-1", name: "Engineer", permissions: ["file.view"] },
  };
});

describe("POST /api/files/bulk-download/prepare", () => {
  it("answers with the size of the zip, and no token, however many files", async () => {
    const small = await (await prepare(seed(2, 1000))).json();
    const large = await (await prepare(seed(500, 1000))).json();

    expect(small).toEqual({ count: 2, totalBytes: 2000, skipped: 0 });
    expect(large).toEqual({ count: 500, totalBytes: 500_000, skipped: 0 });
    // The old answer carried a token of ~260 bytes per file.
    expect(JSON.stringify(large).length).toBeLessThan(100);
  });

  it("refuses a selection over the size cap with a reason and a way forward", async () => {
    const ids = seed(3, 400 * 1024 * 1024);

    const res = await prepare(ids);

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe(
      "This selection is 1.2 GB, and one zip can be at most 1 GB. Select fewer files, or download a subfolder instead."
    );
    expect(body.details).toMatchObject({ fileCount: 3, maxBytes: 1024 ** 3 });
  });

  it("refuses a selection over the file cap", async () => {
    const res = await prepare(Array.from({ length: 1001 }, (_, i) => `f${i}`));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/has 1,001 files, and one zip can hold at most 1,000/);
  });

  it("says so when none of the selection is available", async () => {
    const res = await prepare(["nope"]);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("None of the selected files are available to download.");
  });

  it("403s a role without file.view", async () => {
    state.tenantUser = {
      ...(state.tenantUser as object),
      role: { id: "r", name: "Custom", permissions: [] },
    };
    expect((await prepare(seed(2, 10))).status).toBe(403);
  });
});
