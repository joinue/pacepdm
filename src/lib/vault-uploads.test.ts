import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFakeSupabase, type FakeSupabase } from "@/lib/__mocks__/fake-supabase";

const extract = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/thumbnail", () => ({ extractThumbnail: extract.fn }));
vi.mock("@/lib/db", () => ({ getServiceClient: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ runAfterResponse: vi.fn() }));

import {
  fileNameProblem,
  generateFileThumbnail,
  readUploadGrant,
  signUploadGrant,
  vaultObjectKey,
  THUMBNAIL_SOURCE_MAX_BYTES,
} from "./vault-uploads";
import { ApiFailure } from "./api-route";

const base = {
  purpose: "new" as const,
  tenantId: "tenant-a",
  userId: "user-1",
  fileId: "11111111-1111-4111-8111-111111111111",
  folderId: "folder-1",
  key: "tenant-a/files/11111111-1111-4111-8111-111111111111/obj",
  name: "Bracket.SLDPRT",
  size: 1234,
};
const expectFor = { tenantId: "tenant-a", userId: "user-1", purpose: "new" as const };

function failureOf(fn: () => unknown): ApiFailure {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiFailure) return err;
    throw err;
  }
  throw new Error("expected a failure");
}

beforeEach(() => {
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
  extract.fn.mockReset();
});

/**
 * The grant is the only thing the commit trusts about an upload: which tenant,
 * user, file, storage key, name and size were authorised, and for what.
 */
describe("upload grants", () => {
  it("round-trips what was authorised", () => {
    const grant = readUploadGrant(signUploadGrant(base), expectFor);
    expect(grant).toMatchObject(base);
  });

  it("refuses a grant whose contents were edited", () => {
    const [payload, signature] = signUploadGrant(base).split(".");
    const edited = JSON.parse(Buffer.from(payload, "base64url").toString());
    edited.size = 5;
    const forged = `${Buffer.from(JSON.stringify(edited)).toString("base64url")}.${signature}`;
    expect(failureOf(() => readUploadGrant(forged, expectFor)).status).toBe(400);
  });

  it("refuses an expired grant", () => {
    const token = signUploadGrant(base, Date.now() - 3 * 60 * 60 * 1000);
    expect(failureOf(() => readUploadGrant(token, expectFor)).message).toMatch(/expired/);
  });

  it.each([
    ["another user", { ...expectFor, userId: "user-2" }],
    ["another tenant", { ...expectFor, tenantId: "tenant-b" }],
    ["another purpose", { ...expectFor, purpose: "checkin" as const }],
    ["another file", { ...expectFor, fileId: "22222222-2222-4222-8222-222222222222" }],
  ])("refuses a grant presented by %s", (_label, expectation) => {
    const token = signUploadGrant(base);
    expect(failureOf(() => readUploadGrant(token, expectation)).status).toBe(403);
  });

  it("refuses a grant signed with a different secret", () => {
    const token = signUploadGrant(base);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "a-different-key");
    expect(failureOf(() => readUploadGrant(token, expectFor)).status).toBe(400);
  });
});

describe("file names and storage keys", () => {
  it.each([
    "Ø10 bracket [A].SLDPRT",
    "Bügel – Rev C.pdf",
    "図面 01.dwg",
    "part #3 (50% scale).step",
  ])("accepts %s, which storage refused when names were in keys", (name) => {
    expect(fileNameProblem(name)).toBeNull();
  });

  it.each([
    ["a path separator", "drawings/bracket.pdf"],
    ["a backslash", "drawings\\bracket.pdf"],
    ["a dot segment", ".."],
    ["a control character", "bracket\u0000.pdf"],
    ["nothing", "   "],
  ])("refuses a name with %s", (_label, name) => {
    expect(fileNameProblem(name)).not.toBeNull();
  });

  it("never puts the file name in the storage key", () => {
    const key = vaultObjectKey("tenant-a", base.fileId);
    expect(key).toMatch(/^tenant-a\/files\/11111111-1111-4111-8111-111111111111\/[0-9a-f-]{36}$/);
    expect(vaultObjectKey("tenant-a", base.fileId)).not.toBe(key);
  });
});

/**
 * Thumbnails are extracted after the response. Every outcome records the
 * attempt, so the folder listing does not queue the file again, and nothing
 * lands on a file that has moved to a newer version meanwhile.
 */
describe("generateFileThumbnail", () => {
  let fake: FakeSupabase;
  const job = {
    tenantId: "tenant-a",
    fileId: base.fileId,
    version: 2,
    key: "tenant-a/files/f/v2",
    fileName: "drawing.pdf",
    size: 2048,
  };

  beforeEach(() => {
    fake = createFakeSupabase({
      files: [{ id: base.fileId, tenantId: "tenant-a", currentVersion: 2, thumbnailKey: null }],
    });
    fake.objects.set(job.key, { size: 2048 });
  });

  const file = () => fake.rows("files")[0];

  it("stores the thumbnail and links it", async () => {
    extract.fn.mockResolvedValue({ data: new Uint8Array(10), ext: "png", mimeType: "image/png" });

    await generateFileThumbnail(fake.client as never, job);

    expect(file().thumbnailKey).toMatch(/^tenant-a\/thumbnails\/files\/11111111-.*\.png$/);
    expect(file().thumbnailAttemptedAt).toBeTruthy();
    expect(fake.objects.has(file().thumbnailKey as string)).toBe(true);
  });

  it("records the attempt when there is no preview to extract", async () => {
    extract.fn.mockResolvedValue(null);
    await generateFileThumbnail(fake.client as never, job);
    expect(file().thumbnailKey).toBeNull();
    expect(file().thumbnailAttemptedAt).toBeTruthy();
  });

  it("does not download a file too large to extract from", async () => {
    await generateFileThumbnail(fake.client as never, {
      ...job,
      size: THUMBNAIL_SOURCE_MAX_BYTES + 1,
    });
    expect(extract.fn).not.toHaveBeenCalled();
    expect(file().thumbnailAttemptedAt).toBeTruthy();
  });

  it("does not try a type the extractor cannot read", async () => {
    await generateFileThumbnail(fake.client as never, { ...job, fileName: "assembly.step" });
    expect(extract.fn).not.toHaveBeenCalled();
  });

  it("leaves a newer version's thumbnail alone", async () => {
    extract.fn.mockResolvedValue({ data: new Uint8Array(10), ext: "png", mimeType: "image/png" });
    file().currentVersion = 3;
    file().thumbnailKey = "tenant-a/thumbnails/files/v3.png";

    await generateFileThumbnail(fake.client as never, job);

    expect(file().thumbnailKey).toBe("tenant-a/thumbnails/files/v3.png");
  });

  it("records the attempt when extraction throws", async () => {
    extract.fn.mockRejectedValue(new Error("corrupt"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await generateFileThumbnail(fake.client as never, job);
    expect(file().thumbnailAttemptedAt).toBeTruthy();
  });
});
