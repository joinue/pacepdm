import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createFakeSupabase, type FakeSupabase } from "@/lib/__mocks__/fake-supabase";

/**
 * Check-in: prepare → the browser PUTs the new version to storage → commit;
 * or, with no upload, undo the checkout.
 *
 * The version bytes used to be posted to this route as multipart form data,
 * so a large assembly could not be checked in at all. Driven against an
 * in-memory database and storage that enforce the unique version number, so
 * refusals, races and retries behave as they would against Supabase.
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
  notify: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/mentions", () => ({ processMentions: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/thumbnail", () => ({ extractThumbnail: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/folder-access", async () => {
  const actual = await vi.importActual<typeof import("@/lib/folder-access")>("@/lib/folder-access");
  return { ...actual, getFolderAccessScope: vi.fn(async () => actual.openScope()) };
});

import { POST as commit } from "./route";
import { POST as prepare } from "./upload/route";
import { logAudit } from "@/lib/audit";
import { notify } from "@/lib/notifications";

const TENANT = "tenant-a";
const FILE_ID = "0f5e0a8c-1111-4111-8111-000000000001";
const OTHER_FILE_ID = "0f5e0a8c-1111-4111-8111-000000000002";

const owner = {
  id: "user-1",
  tenantId: TENANT,
  fullName: "Alice",
  roleId: "role-eng",
  role: { permissions: ["file.checkin"] },
};
const otherUser = { ...owner, id: "user-2", fullName: "Bob" };
const admin = { ...owner, id: "admin-1", fullName: "Admin", role: { permissions: ["*"] } };

const checkedOutFile = {
  id: FILE_ID,
  tenantId: TENANT,
  folderId: "folder-1",
  name: "bracket.sldprt",
  revision: "A",
  currentVersion: 2,
  isFrozen: false,
  isCheckedOut: true,
  checkedOutById: "user-1",
  checkedOutAt: "2026-09-15T08:00:00Z",
  deletedAt: null,
};

const params = (fileId = FILE_ID) => ({ params: Promise.resolve({ fileId }) });

function post(url: string, body: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

/** Prepare a check-in and put the object into storage, as the browser would. */
async function uploadedVersion(size = 80 * 1024 * 1024) {
  const res = await prepare(
    post(`/api/files/${FILE_ID}/checkin/upload`, { fileName: "bracket.sldprt", size }),
    params()
  );
  expect(res.status).toBe(200);
  const key = state.fake.signedUploadKeys.at(-1)!;
  state.fake.objects.set(key, { size });
  return { token: (await res.json()).uploadToken as string, key };
}

const checkIn = (body: unknown, fileId = FILE_ID) =>
  commit(post(`/api/files/${fileId}/checkin`, body), params(fileId));

const file = () => state.fake.rows("files").find((f) => f.id === FILE_ID)!;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
  state.fake = createFakeSupabase({
    files: [{ ...checkedOutFile }],
    file_versions: [
      { id: "v1", fileId: FILE_ID, version: 1, storageKey: "k1", fileSize: 1 },
      { id: "v2", fileId: FILE_ID, version: 2, storageKey: "k2", fileSize: 1 },
    ],
  });
  state.user = owner;
  state.afterTasks.length = 0;
});

describe("checking in a new version", () => {
  it("records the next version, releases the checkout and schedules the thumbnail", async () => {
    const { token, key } = await uploadedVersion(80 * 1024 * 1024);

    const res = await checkIn({ uploadToken: token, comment: "Thickened the web" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, version: 3 });
    expect(file()).toMatchObject({ currentVersion: 3, isCheckedOut: false, checkedOutById: null });
    expect(state.fake.rows("file_versions").find((v) => v.version === 3)).toMatchObject({
      storageKey: key,
      fileSize: 80 * 1024 * 1024,
      comment: "Thickened the web",
      revision: "A",
    });
    expect(state.afterTasks).toHaveLength(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "file.checkin",
        details: { name: "bracket.sldprt", version: 3 },
      })
    );
  });

  it("refuses at prepare, before any bytes move, when the file is not checked out", async () => {
    file().isCheckedOut = false;
    const res = await prepare(
      post(`/api/files/${FILE_ID}/checkin/upload`, { fileName: "bracket.sldprt", size: 10 }),
      params()
    );
    expect(res.status).toBe(409);
    expect(state.fake.signedUploadKeys).toHaveLength(0);
  });

  it("refuses a version for a file that froze while it uploaded, and removes the upload", async () => {
    const { token, key } = await uploadedVersion();
    file().isFrozen = true;

    const res = await checkIn({ uploadToken: token });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/frozen/i);
    expect(file().currentVersion).toBe(2);
    expect(state.fake.objects.has(key)).toBe(false);
  });

  /** A version checked in mid-review is what the approval would release, unreviewed. */
  it("refuses a new version while a transition on the file is awaiting approval", async () => {
    const { token } = await uploadedVersion();
    state.fake.tables.approval_requests = [
      {
        id: "req-1",
        tenantId: TENANT,
        entityType: "file",
        entityId: FILE_ID,
        status: "PENDING",
        title: "Release",
      },
    ];

    const res = await checkIn({ uploadToken: token });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/awaiting approval/i);
    expect(state.fake.rows("file_versions")).toHaveLength(2);
  });

  it("refuses someone else's checkout for a non-admin", async () => {
    file().checkedOutById = "user-2";
    const res = await prepare(
      post(`/api/files/${FILE_ID}/checkin/upload`, { fileName: "bracket.sldprt", size: 10 }),
      params()
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/another user/i);
  });

  it("lets an admin check in someone else's file, and tells them", async () => {
    file().checkedOutById = "user-2";
    state.user = admin;
    const { token } = await uploadedVersion();

    const res = await checkIn({ uploadToken: token });

    expect(res.status).toBe(200);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ userIds: ["user-2"], title: "File checked in by admin" })
    );
  });

  it("refuses a grant issued for another file", async () => {
    const { token } = await uploadedVersion();
    state.fake.tables.files.push({ ...checkedOutFile, id: OTHER_FILE_ID });
    const res = await checkIn({ uploadToken: token }, OTHER_FILE_ID);
    expect(res.status).toBe(403);
  });

  /**
   * A checkout released and retaken while the upload ran — or another
   * version landing — must not be silently overwritten. It used to be:
   * the final update cleared whatever checkout was there.
   */
  it("refuses, and leaves no stray version row, when the file changed while committing", async () => {
    const { token, key } = await uploadedVersion();
    // After the commit has loaded the file and written its version row, but
    // before it moves the file, the checkout is released and retaken by Bob.
    state.fake.beforeNext.update.files = () => {
      file().checkedOutById = "user-2";
    };

    const res = await checkIn({ uploadToken: token });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/changed while this version uploaded/);
    // Bob's checkout survives, the file stays on version 2, and the version
    // row written for this attempt is gone again.
    expect(file()).toMatchObject({
      currentVersion: 2,
      checkedOutById: "user-2",
      isCheckedOut: true,
    });
    expect(state.fake.rows("file_versions").map((v) => v.version)).toEqual([1, 2]);
    expect(state.fake.objects.has(key)).toBe(false);
  });

  it("refuses when another version took the number first", async () => {
    const { token, key } = await uploadedVersion();
    state.fake.beforeNext.insert.file_versions = () => {
      state.fake.tables.file_versions.push({
        id: "v3-bob",
        fileId: FILE_ID,
        version: 3,
        storageKey: "k3",
        fileSize: 1,
      });
    };

    const res = await checkIn({ uploadToken: token });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/added by someone else/);
    expect(file().currentVersion).toBe(2);
    expect(state.fake.objects.has(key)).toBe(false);
  });

  it("returns the version it created when a check-in that already landed is retried", async () => {
    const { token, key } = await uploadedVersion();
    await checkIn({ uploadToken: token });

    const retry = await checkIn({ uploadToken: token });

    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ success: true, version: 3 });
    expect(state.fake.rows("file_versions")).toHaveLength(3);
    expect(state.fake.objects.has(key)).toBe(true);
  });

  it("requires file.checkin", async () => {
    state.user = { ...owner, role: { permissions: ["file.view"] } };
    const res = await checkIn({});
    expect(res.status).toBe(403);
  });

  it("returns 401 when not signed in", async () => {
    state.user = null;
    expect((await checkIn({})).status).toBe(401);
  });
});

describe("undoing a checkout", () => {
  it("releases the checkout without a version and audits it", async () => {
    const res = await checkIn({});

    expect(res.status).toBe(200);
    expect(file()).toMatchObject({ isCheckedOut: false, checkedOutById: null, currentVersion: 2 });
    expect(state.fake.rows("file_versions")).toHaveLength(2);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "file.undo_checkout" })
    );
  });

  it("returns 409 if the file is not checked out", async () => {
    file().isCheckedOut = false;
    const res = await checkIn({});
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/not checked out/i);
  });

  it("returns 403 for someone else's checkout (non-admin)", async () => {
    state.user = otherUser;
    const res = await checkIn({});
    expect(res.status).toBe(403);
  });

  /**
   * The release valve. An approval that completed while the file was checked
   * out left it frozen and checked out at once; undo writes no version, so it
   * stays allowed.
   */
  it("lets the checkout of a frozen file be undone", async () => {
    file().isFrozen = true;
    const res = await checkIn({});
    expect(res.status).toBe(200);
    expect(file().isCheckedOut).toBe(false);
  });

  it("lets an admin unlock someone else's checkout of a frozen file", async () => {
    file().isFrozen = true;
    file().checkedOutById = "user-2";
    state.user = admin;
    const res = await checkIn({});
    expect(res.status).toBe(200);
  });

  it("still lets the checkout be undone while awaiting approval", async () => {
    state.fake.tables.approval_requests = [
      { id: "req-1", tenantId: TENANT, entityType: "file", entityId: FILE_ID, status: "PENDING" },
    ];
    const res = await checkIn({});
    expect(res.status).toBe(200);
  });

  it("404s a file in another tenant", async () => {
    file().tenantId = "tenant-b";
    expect((await checkIn({})).status).toBe(404);
  });
});
