import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createFakeSupabase, type FakeSupabase } from "@/lib/__mocks__/fake-supabase";

/**
 * Uploading a new file: prepare → the browser PUTs to storage → commit.
 *
 * Every upload used to go through this route as multipart form data, held in
 * function memory, so Vercel's 100 MB request limit or the storage limit was
 * the real ceiling and a failure said only "Failed to upload file". These
 * tests drive the three steps against an in-memory database and storage that
 * enforce the unique indexes and keep object sizes, so a refusal, a race and a
 * retry behave the way they would against Supabase.
 */

const state = vi.hoisted(() => ({
  fake: null as unknown as FakeSupabase,
  user: null as null | {
    id: string;
    tenantId: string;
    fullName: string;
    roleId: string;
    role: { permissions: string[] };
  },
  afterTasks: [] as (() => Promise<unknown>)[],
}));

vi.mock("@/lib/db", () => ({ getServiceClient: () => state.fake.client }));
vi.mock("@/lib/auth", () => ({ getApiTenantUser: () => Promise.resolve(state.user) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/notifications", () => ({
  runAfterResponse: (task: () => Promise<unknown>) => state.afterTasks.push(task),
  sideEffect: (p: Promise<unknown>) => p,
  notify: vi.fn(),
}));
vi.mock("@/lib/thumbnail", () => ({ extractThumbnail: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/folder-access", async () => {
  const actual = await vi.importActual<typeof import("@/lib/folder-access")>("@/lib/folder-access");
  return { ...actual, getFolderAccessScope: vi.fn(async () => actual.openScope()) };
});

import { GET, POST as commit } from "./route";
import { POST as prepare } from "./uploads/route";
import { getFolderAccessScope, closedScope } from "@/lib/folder-access";

const TENANT = "tenant-a";
const FOLDER = "5d0f7b1e-0000-4000-8000-000000000001";

const engineer = {
  id: "user-1",
  tenantId: TENANT,
  fullName: "Pat Lee",
  roleId: "role-eng",
  role: { permissions: ["file.upload", "file.view"] },
};

function post(url: string, body: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

async function prepareUpload(fileName = "Ø10 bracket [A].SLDPRT", size = 150 * 1024 * 1024) {
  const res = await prepare(post("/api/files/uploads", { folderId: FOLDER, fileName, size }));
  return { res, body: await res.json() };
}

/** Prepare, then do what the browser does: put the object into storage. */
async function uploaded(fileName?: string, size = 150 * 1024 * 1024) {
  const { res, body } = await prepareUpload(fileName, size);
  expect(res.status).toBe(200);
  const key = state.fake.signedUploadKeys.at(-1)!;
  state.fake.objects.set(key, { size });
  return { token: body.uploadToken as string, key };
}

beforeEach(() => {
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
  state.fake = createFakeSupabase({
    folders: [{ id: FOLDER, tenantId: TENANT, name: "Fixtures", path: "/Fixtures" }],
    lifecycles: [{ id: "lc-1", tenantId: TENANT, isDefault: true }],
  });
  state.user = engineer;
  state.afterTasks.length = 0;
  vi.mocked(getFolderAccessScope).mockClear();
});

describe("preparing an upload", () => {
  it("returns a storage URL and a grant, and never puts the name in the storage key", async () => {
    const { res, body } = await prepareUpload("Ø10 bracket [A].SLDPRT");

    expect(res.status).toBe(200);
    expect(body.uploadUrl).toContain("https://storage.test/upload/sign/");
    expect(body.uploadToken).toEqual(expect.any(String));
    const key = state.fake.signedUploadKeys[0];
    expect(key).toMatch(new RegExp(`^${TENANT}/files/[0-9a-f-]{36}/[0-9a-f-]{36}$`));
    expect(key).not.toContain("bracket");
  });

  it("accepts a file far larger than a request body could carry", async () => {
    const { res } = await prepareUpload("assembly.SLDASM", 3 * 1024 * 1024 * 1024);
    expect(res.status).toBe(200);
  });

  it("offers the existing file before any bytes are sent when the name is taken", async () => {
    state.fake.tables.files = [
      {
        id: "existing-1",
        tenantId: TENANT,
        folderId: FOLDER,
        name: "bracket.pdf",
        currentVersion: 4,
        isCheckedOut: false,
        checkedOutById: null,
        isFrozen: false,
        lifecycleState: "WIP",
        deletedAt: null,
      },
    ];

    const { res, body } = await prepareUpload("bracket.pdf");

    expect(res.status).toBe(409);
    expect(body.details).toMatchObject({
      code: "DUPLICATE_FILE",
      existingFile: { id: "existing-1", currentVersion: 4 },
    });
    expect(state.fake.signedUploadKeys).toHaveLength(0);
  });

  it("does not count a same-named file in another tenant as a duplicate", async () => {
    state.fake.tables.files = [
      {
        id: "theirs",
        tenantId: "tenant-b",
        folderId: FOLDER,
        name: "bracket.pdf",
        deletedAt: null,
      },
    ];
    const { res } = await prepareUpload("bracket.pdf");
    expect(res.status).toBe(200);
  });

  it("404s a folder that belongs to another tenant", async () => {
    state.fake.tables.folders[0].tenantId = "tenant-b";
    const { res } = await prepareUpload();
    expect(res.status).toBe(404);
  });

  it("refuses a folder the caller can see but not write to", async () => {
    vi.mocked(getFolderAccessScope).mockResolvedValueOnce({
      ...closedScope(false),
      allowed: new Set([FOLDER]),
    });
    const { res } = await prepareUpload();
    expect(res.status).toBe(403);
  });

  it("refuses a name with a path separator", async () => {
    const { res, body } = await prepareUpload("drawings/bracket.pdf");
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/cannot contain/);
  });

  it("requires file.upload", async () => {
    state.user = { ...engineer, role: { permissions: ["file.view"] } };
    const { res } = await prepareUpload();
    expect(res.status).toBe(403);
  });
});

describe("committing an upload", () => {
  it("records the file and its first version, pointing at the uploaded object", async () => {
    const { token, key } = await uploaded("Ø10 bracket [A].SLDPRT", 150 * 1024 * 1024);

    const res = await commit(post("/api/files", { uploadToken: token, description: "Machined" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      name: "Ø10 bracket [A].SLDPRT",
      folderId: FOLDER,
      tenantId: TENANT,
      currentVersion: 1,
      lifecycleState: "WIP",
      description: "Machined",
    });
    expect(state.fake.rows("file_versions")).toEqual([
      expect.objectContaining({
        fileId: body.id,
        version: 1,
        storageKey: key,
        fileSize: 150 * 1024 * 1024,
      }),
    ]);
  });

  it("extracts the thumbnail after the response, not during it", async () => {
    const { token } = await uploaded("drawing.pdf", 2048);
    await commit(post("/api/files", { uploadToken: token }));
    expect(state.afterTasks).toHaveLength(1);
  });

  it("refuses to record an upload that never reached storage", async () => {
    const { res, body } = await prepareUpload();
    const r = await commit(post("/api/files", { uploadToken: body.uploadToken }));

    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/not finished uploading/);
    expect(state.fake.rows("files")).toHaveLength(0);
    expect(res.status).toBe(200);
  });

  it("refuses an object of a different size than was authorised, and removes it", async () => {
    const { token, key } = await uploaded("bracket.pdf", 5000);
    state.fake.objects.set(key, { size: 4999 });

    const res = await commit(post("/api/files", { uploadToken: token }));

    expect(res.status).toBe(409);
    expect(state.fake.objects.has(key)).toBe(false);
    expect(state.fake.rows("files")).toHaveLength(0);
  });

  it("refuses another user's grant", async () => {
    const { token } = await uploaded();
    state.user = { ...engineer, id: "user-2" };
    const res = await commit(post("/api/files", { uploadToken: token }));
    expect(res.status).toBe(403);
  });

  it("refuses a grant from another tenant", async () => {
    const { token } = await uploaded();
    state.user = { ...engineer, tenantId: "tenant-b" };
    const res = await commit(post("/api/files", { uploadToken: token }));
    expect(res.status).toBe(403);
  });

  it("removes the upload when a same-named file landed while it was uploading", async () => {
    const { token, key } = await uploaded("bracket.pdf", 100);
    state.fake.tables.files = [
      { id: "other", tenantId: TENANT, folderId: FOLDER, name: "bracket.pdf", deletedAt: null },
    ];

    const res = await commit(post("/api/files", { uploadToken: token }));

    expect(res.status).toBe(409);
    expect((await res.json()).details).toMatchObject({ code: "DUPLICATE_FILE" });
    expect(state.fake.objects.has(key)).toBe(false);
  });

  it("returns the same file when a commit that already landed is retried", async () => {
    const { token, key } = await uploaded("bracket.pdf", 100);
    const first = await (await commit(post("/api/files", { uploadToken: token }))).json();

    const retry = await commit(post("/api/files", { uploadToken: token }));

    expect(retry.status).toBe(200);
    expect((await retry.json()).id).toBe(first.id);
    expect(state.fake.rows("files")).toHaveLength(1);
    expect(state.fake.rows("file_versions")).toHaveLength(1);
    // The retry must not have mistaken its own file for a duplicate and
    // deleted the object that file points at.
    expect(state.fake.objects.has(key)).toBe(true);
  });

  it("leaves no file behind when the version row cannot be written", async () => {
    const { token, key } = await uploaded("bracket.pdf", 100);
    state.fake.failNext.insert.file_versions = { message: "connection reset" };

    const res = await commit(post("/api/files", { uploadToken: token }));

    expect(res.status).toBe(500);
    expect(state.fake.rows("files")).toHaveLength(0);
    expect(state.fake.objects.has(key)).toBe(false);
  });

  it("ignores a lifecycle state chosen by a non-admin", async () => {
    const { token } = await uploaded("bracket.pdf", 100);
    const body = await (
      await commit(post("/api/files", { uploadToken: token, lifecycleState: "Released" }))
    ).json();
    expect(body).toMatchObject({ lifecycleState: "WIP", isFrozen: false });
  });
});

/**
 * The folder listing read every row in one request. PostgREST caps a response
 * at 1,000 rows, so the rest of a large folder vanished from the listing, and
 * the `.in()` lookups for versions and approvals put every file id in the URL.
 */
describe("listing a folder", () => {
  function seedFolder(count: number) {
    state.fake.tables.files = Array.from({ length: count }, (_, i) => ({
      id: `file-${String(i).padStart(5, "0")}`,
      tenantId: TENANT,
      folderId: FOLDER,
      name: `part-${String(i).padStart(5, "0")}.pdf`,
      fileType: "pdf",
      currentVersion: 1,
      thumbnailKey: null,
      thumbnailAttemptedAt: null,
      deletedAt: null,
    }));
    state.fake.tables.file_versions = state.fake.tables.files.map((f) => ({
      fileId: f.id,
      version: 1,
      storageKey: `${TENANT}/files/${f.id}/v1`,
      fileSize: 10,
      createdAt: "2026-09-01T00:00:00Z",
    }));
  }

  const list = () => GET(new NextRequest(`http://localhost/api/files?folderId=${FOLDER}`));

  it("returns every file past the 1,000-row cap, each with its version", async () => {
    seedFolder(1250);

    const res = await list();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1250);
    expect(body[1249].versions).toEqual([expect.objectContaining({ version: 1, fileSize: 10 })]);
  });

  it("queues a few thumbnail backfills after the response instead of extracting inline", async () => {
    seedFolder(20);
    await list();
    expect(state.afterTasks).toHaveLength(1);
  });

  it("does not list another tenant's files in the same folder id", async () => {
    seedFolder(2);
    state.fake.tables.files[1].tenantId = "tenant-b";
    const body = await (await list()).json();
    expect(body.map((f: { id: string }) => f.id)).toEqual(["file-00000"]);
  });
});
