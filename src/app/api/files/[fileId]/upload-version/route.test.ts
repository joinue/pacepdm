import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createFakeSupabase, type FakeSupabase } from "@/lib/__mocks__/fake-supabase";

/**
 * "Upload as new version": a version added without a checkout, from the
 * duplicate-name prompt. The checkout lock alone does not stop it replacing a
 * file under review or one someone else is editing, so the route checks both,
 * at prepare and again at commit.
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
}));

vi.mock("@/lib/db", () => ({ getServiceClient: () => state.fake.client }));
vi.mock("@/lib/auth", () => ({ getApiTenantUser: () => Promise.resolve(state.user) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/notifications", () => ({
  runAfterResponse: vi.fn(),
  sideEffect: (p: unknown) => p,
}));
vi.mock("@/lib/thumbnail", () => ({ extractThumbnail: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/folder-access", async () => {
  const actual = await vi.importActual<typeof import("@/lib/folder-access")>("@/lib/folder-access");
  return { ...actual, getFolderAccessScope: vi.fn(async () => actual.openScope()) };
});

import { POST as commit } from "./route";
import { POST as prepare } from "./upload/route";

const TENANT = "tenant-a";
const FILE_ID = "7c4b2a10-2222-4222-8222-000000000001";
const params = { params: Promise.resolve({ fileId: FILE_ID }) };

const uploader = {
  id: "user-1",
  tenantId: TENANT,
  fullName: "Alice",
  roleId: "role-eng",
  role: { permissions: ["file.upload"] },
};

function post(url: string, body: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

async function uploaded(size = 2048) {
  const res = await prepare(
    post(`/api/files/${FILE_ID}/upload-version/upload`, { fileName: "bracket.pdf", size }),
    params
  );
  const body = await res.json();
  if (res.status !== 200) return { res, body };
  const key = state.fake.signedUploadKeys.at(-1)!;
  state.fake.objects.set(key, { size });
  return { res, body, key, token: body.uploadToken as string };
}

const file = () => state.fake.rows("files")[0];

beforeEach(() => {
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
  state.fake = createFakeSupabase({
    files: [
      {
        id: FILE_ID,
        tenantId: TENANT,
        folderId: "folder-1",
        name: "bracket.pdf",
        revision: "B",
        currentVersion: 4,
        isFrozen: false,
        isCheckedOut: false,
        checkedOutById: null,
        deletedAt: null,
      },
    ],
    file_versions: [{ id: "v4", fileId: FILE_ID, version: 4, storageKey: "k4", fileSize: 1 }],
  });
  state.user = uploader;
});

describe("POST /api/files/[fileId]/upload-version", () => {
  it("adds the next version when nothing is pending", async () => {
    const { token, key } = await uploaded();

    const res = await commit(
      post(`/api/files/${FILE_ID}/upload-version`, { uploadToken: token }),
      params
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, version: 5 });
    expect(file().currentVersion).toBe(5);
    expect(state.fake.rows("file_versions").at(-1)).toMatchObject({ version: 5, storageKey: key });
  });

  it("refuses a new version while a transition on the file is awaiting approval", async () => {
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

    const { res, body } = await uploaded();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/awaiting approval/i);
    expect(state.fake.signedUploadKeys).toHaveLength(0);
  });

  it("refuses a file someone else has checked out", async () => {
    file().isCheckedOut = true;
    file().checkedOutById = "user-2";
    const { res } = await uploaded();
    expect(res.status).toBe(409);
  });

  it("refuses a released file", async () => {
    file().isFrozen = true;
    const { res, body } = await uploaded();
    expect(res.status).toBe(409);
    expect(body.error).toMatch(/Revise it first/);
  });

  /**
   * A checkout taken while the upload ran used to be silently cleared by the
   * final update, and that user's later check-in then overwrote this version.
   */
  it("does not clear a checkout taken while the version uploaded", async () => {
    const { token } = await uploaded();
    file().isCheckedOut = true;
    file().checkedOutById = "user-2";

    const res = await commit(
      post(`/api/files/${FILE_ID}/upload-version`, { uploadToken: token }),
      params
    );

    expect(res.status).toBe(409);
    expect(file()).toMatchObject({
      isCheckedOut: true,
      checkedOutById: "user-2",
      currentVersion: 4,
    });
  });

  it("refuses a check-in grant", async () => {
    // Check-in requires file.checkin and a checkout; its grant must not
    // stand in for this route's.
    state.user = { ...uploader, role: { permissions: ["file.upload", "file.checkin"] } };
    file().isCheckedOut = true;
    file().checkedOutById = "user-1";
    const { POST: prepareCheckin } = await import("../checkin/upload/route");
    const prepared = await prepareCheckin(
      post(`/api/files/${FILE_ID}/checkin/upload`, { fileName: "bracket.pdf", size: 10 }),
      params
    );
    const { uploadToken } = await prepared.json();

    const res = await commit(post(`/api/files/${FILE_ID}/upload-version`, { uploadToken }), params);

    expect(res.status).toBe(403);
  });

  it("requires file.upload", async () => {
    state.user = { ...uploader, role: { permissions: ["file.checkin"] } };
    const { res } = await uploaded();
    expect(res.status).toBe(403);
  });
});
