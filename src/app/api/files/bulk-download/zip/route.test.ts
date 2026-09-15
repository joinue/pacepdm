import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { unzipSync, strFromU8, strToU8 } from "fflate";

/**
 * The bulk zip is started by a hidden form POST from the vault, so the
 * selection rides in the body and the URL is the same for any number of files.
 * It used to be a GET carrying every file's storage key in a signed token,
 * which failed past ~50 files and trusted whatever the token said — so access
 * revoked after prepare did not stop the download. These tests pin both.
 */

const { state } = vi.hoisted(() => ({
  state: {
    tenantUser: null as unknown,
    scope: null as unknown,
    client: null as unknown,
  },
}));

vi.mock("@/lib/db", () => ({ getServiceClient: () => state.client }));
vi.mock("@/lib/auth", () => ({ getApiTenantUser: () => Promise.resolve(state.tenantUser) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/folder-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/folder-access")>()),
  getFolderAccessScope: vi.fn(() => Promise.resolve(state.scope)),
}));

import { POST } from "./route";
import { POST as PREPARE } from "../prepare/route";
import { logAudit } from "@/lib/audit";
import { getFolderAccessScope, openScope } from "@/lib/folder-access";
import { createFakeVault, readAll, type FakeVault } from "@/lib/__mocks__/fake-vault";

const TENANT = "tenant-1";
let vault: FakeVault;

const engineer = {
  id: "user-1",
  tenantId: TENANT,
  authUserId: "auth-1",
  roleId: "role-1",
  role: { id: "role-1", name: "Engineer", permissions: ["file.view"] },
};

function zipRequest(fileIds: string[], headers: Record<string, string> = {}) {
  const body = new URLSearchParams(fileIds.map((id) => ["fileId", id]));
  return new NextRequest("http://localhost/api/files/bulk-download/zip", {
    method: "POST",
    body,
    headers: { "sec-fetch-site": "same-origin", ...headers },
  });
}

function seed(files: { id: string; folderId: string; name: string; text: string }[]) {
  vault.tables.files = files.map((f) => ({
    id: f.id,
    tenantId: TENANT,
    folderId: f.folderId,
    name: f.name,
    currentVersion: 1,
    deletedAt: null,
  }));
  vault.tables.file_versions = files.map((f) => ({
    id: `${f.id}-v1`,
    fileId: f.id,
    version: 1,
    storageKey: `${TENANT}/${f.id}`,
    fileSize: f.text.length,
  }));
  for (const f of files) vault.blobs.set(`${TENANT}/${f.id}`, strToU8(f.text));
}

beforeEach(() => {
  vi.clearAllMocks();
  vault = createFakeVault();
  vi.stubGlobal("fetch", vault.fetch);
  state.client = vault.client;
  state.tenantUser = engineer;
  state.scope = openScope();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/files/bulk-download/zip", () => {
  it("streams the selected files as an attachment", async () => {
    seed([
      { id: "f1", folderId: "d1", name: "bracket.pdf", text: "bracket" },
      { id: "f2", folderId: "d1", name: "housing.step", text: "housing" },
    ]);

    const res = await POST(zipRequest(["f1", "f2"]));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="vault-\d{4}-\d{2}-\d{2}\.zip"$/
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const files = unzipSync(await readAll(res.body!));
    expect(Object.keys(files).sort()).toEqual(["bracket.pdf", "housing.step"]);
    expect(strFromU8(files["bracket.pdf"])).toBe("bracket");
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "file.bulk_download",
        userId: "user-1",
        details: { count: 2, totalBytes: 14 },
      })
    );
  });

  it("takes 500 files at the same URL as two", async () => {
    const files = Array.from({ length: 500 }, (_, i) => ({
      id: `f${String(i).padStart(3, "0")}`,
      folderId: "d1",
      name: `part-${i}.sldprt`,
      text: "x",
    }));
    seed(files);

    const req = zipRequest(files.map((f) => f.id));
    expect(req.nextUrl.pathname).toBe("/api/files/bulk-download/zip");
    expect(req.nextUrl.search).toBe("");

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(Object.keys(unzipSync(await readAll(res.body!)))).toHaveLength(500);
  });

  /**
   * Prepare approved this selection; the caller then lost access to the
   * folder before the form was submitted. The download must honour the loss.
   */
  it("re-checks folder access when the download starts, not only at prepare", async () => {
    seed([
      { id: "f1", folderId: "public", name: "ok.pdf", text: "ok" },
      { id: "f2", folderId: "restricted", name: "secret.pdf", text: "secret" },
    ]);

    const prep = await PREPARE(
      new NextRequest("http://localhost/api/files/bulk-download/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileIds: ["f1", "f2"] }),
      })
    );
    expect(await prep.json()).toMatchObject({ count: 2 });

    state.scope = { ...openScope(), restrictedAny: true, allowed: new Set(["public"]) };
    const res = await POST(zipRequest(["f1", "f2"]));

    expect(res.status).toBe(200);
    expect(getFolderAccessScope).toHaveBeenCalledTimes(2);
    expect(Object.keys(unzipSync(await readAll(res.body!)))).toEqual(["ok.pdf"]);
    expect(vault.fetched).not.toContain(`${TENANT}/f2`);
  });

  it("refuses outright when nothing in the selection is still accessible", async () => {
    seed([{ id: "f1", folderId: "restricted", name: "secret.pdf", text: "secret" }]);
    state.scope = { ...openScope(), restrictedAny: true };

    const res = await POST(zipRequest(["f1"]));

    expect(res.status).toBe(404);
    expect(vault.fetched).toEqual([]);
  });

  it("does not trust a tenant from anywhere but the session", async () => {
    seed([{ id: "f1", folderId: "d1", name: "a.pdf", text: "a" }]);
    state.tenantUser = { ...engineer, id: "user-2", tenantId: "tenant-2" };

    const res = await POST(zipRequest(["f1"]));

    expect(res.status).toBe(404);
    expect(vault.fetched).toEqual([]);
  });

  it("401s without a session", async () => {
    state.tenantUser = null;
    expect((await POST(zipRequest(["f1"]))).status).toBe(401);
  });

  it("refuses a form submitted from another site before doing any work", async () => {
    seed([{ id: "f1", folderId: "d1", name: "a.pdf", text: "a" }]);

    const res = await POST(zipRequest(["f1"], { "sec-fetch-site": "cross-site" }));

    expect(res.status).toBe(403);
    expect(vault.reads).toEqual([]);
  });

  it("400s a submission with no files", async () => {
    expect((await POST(zipRequest([]))).status).toBe(400);
  });
});
