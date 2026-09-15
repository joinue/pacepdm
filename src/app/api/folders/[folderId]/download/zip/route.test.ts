import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { unzipSync, strFromU8, strToU8 } from "fflate";

/**
 * A folder zip is resolved and authorized when the form POST arrives, not
 * when prepare ran. The URL carries only the folder id, so it is the same size
 * for a folder of two files or a thousand.
 */

const { state } = vi.hoisted(() => ({
  state: { tenantUser: null as unknown, scope: null as unknown, client: null as unknown },
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
import { openScope } from "@/lib/folder-access";
import { createFakeVault, readAll, type FakeVault } from "@/lib/__mocks__/fake-vault";

const TENANT = "tenant-1";
let vault: FakeVault;

function call(
  handler: typeof POST,
  action: "zip" | "prepare",
  headers: Record<string, string> = {}
) {
  return handler(
    new NextRequest(`http://localhost/api/folders/root/download/${action}`, {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin", ...headers },
    }),
    { params: Promise.resolve({ folderId: "root" }) }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vault = createFakeVault();
  vi.stubGlobal("fetch", vault.fetch);
  state.client = vault.client;
  state.scope = openScope();
  state.tenantUser = {
    id: "user-1",
    tenantId: TENANT,
    roleId: "role-1",
    role: { id: "role-1", name: "Engineer", permissions: ["file.view"] },
  };

  vault.tables.folders = [
    { id: "root", tenantId: TENANT, name: "Widget-X", path: "/Widget-X" },
    { id: "dwg", tenantId: TENANT, name: "Drawings", path: "/Widget-X/Drawings" },
  ];
  vault.tables.files = [
    {
      id: "f1",
      tenantId: TENANT,
      folderId: "root",
      name: "readme.txt",
      currentVersion: 1,
      deletedAt: null,
    },
    {
      id: "f2",
      tenantId: TENANT,
      folderId: "dwg",
      name: "bracket.pdf",
      currentVersion: 1,
      deletedAt: null,
    },
  ];
  vault.tables.file_versions = [
    { id: "v1", fileId: "f1", version: 1, storageKey: "k/f1", fileSize: 6 },
    { id: "v2", fileId: "f2", version: 1, storageKey: "k/f2", fileSize: 7 },
  ];
  vault.blobs.set("k/f1", strToU8("readme"));
  vault.blobs.set("k/f2", strToU8("bracket"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/folders/[folderId]/download/zip", () => {
  it("streams the folder with its hierarchy, named after the folder", async () => {
    const res = await call(POST, "zip");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="Widget-X.zip"');
    const files = unzipSync(await readAll(res.body!));
    expect(Object.keys(files)).toEqual(["Widget-X/Drawings/bracket.pdf", "Widget-X/readme.txt"]);
    expect(strFromU8(files["Widget-X/readme.txt"])).toBe("readme");
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "folder.download", entityId: "root" })
    );
  });

  it("refuses the download when access was revoked after prepare", async () => {
    expect((await call(PREPARE, "prepare")).status).toBe(200);

    state.scope = { ...openScope(), restrictedAny: true };
    const res = await call(POST, "zip");

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("You do not have access to this folder.");
    expect(vault.fetched).toEqual([]);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("leaves out a subfolder hidden since prepare", async () => {
    state.scope = { ...openScope(), restrictedAny: true, allowed: new Set(["root"]) };
    const res = await call(POST, "zip");
    expect(Object.keys(unzipSync(await readAll(res.body!)))).toEqual(["Widget-X/readme.txt"]);
  });

  it("names a file whose stored copy is gone in MISSING.txt", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vault.blobs.delete("k/f2");

    const res = await call(POST, "zip");

    const files = unzipSync(await readAll(res.body!));
    expect(Object.keys(files)).toEqual(["Widget-X/readme.txt", "MISSING.txt"]);
    expect(strFromU8(files["MISSING.txt"])).toContain("Widget-X/Drawings/bracket.pdf");
  });

  it("refuses a form submitted from another site", async () => {
    const res = await call(POST, "zip", { "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
    expect(vault.reads).toEqual([]);
  });
});

describe("POST /api/folders/[folderId]/download/prepare", () => {
  it("answers with the folder's size", async () => {
    const res = await call(PREPARE, "prepare");
    expect(await res.json()).toEqual({ count: 2, totalBytes: 13, rootName: "Widget-X" });
  });

  it("refuses a folder over the size cap and suggests its subfolders", async () => {
    vault.tables.file_versions[1].fileSize = 2 * 1024 ** 3;

    const res = await call(PREPARE, "prepare");

    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe(
      "This folder is 2 GB, and one zip can be at most 1 GB. Download its subfolders one at a time instead."
    );
  });

  it("404s a folder with nothing in it", async () => {
    vault.tables.files = [];
    const res = await call(PREPARE, "prepare");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("This folder has no files to download.");
  });
});
