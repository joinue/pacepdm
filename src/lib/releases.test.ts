import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { unzipSync, strFromU8, strToU8 } from "fflate";
import { buildReleaseZipStream, type ReleaseRow } from "./releases";
import { createFakeVault, readAll, type FakeVault } from "./__mocks__/fake-vault";

/**
 * A release zip is what a CM files as the record of what an ECO shipped. The
 * builder used to skip a file it could not fetch with nothing in the archive
 * to say so — while its own comment promised a note in manifest.json.
 */

let vault: FakeVault;

beforeEach(() => {
  vault = createFakeVault();
  vi.stubGlobal("fetch", vault.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function releaseFile(fileId: string, fileName: string) {
  return {
    fileId,
    fileName,
    fileType: fileName.split(".").pop() ?? "",
    versionId: `${fileId}-v1`,
    version: 1,
    revision: "B",
    storageKey: `tenant-1/${fileId}`,
    lifecycleState: "Released",
  };
}

function release(files: ReturnType<typeof releaseFile>[]): ReleaseRow {
  return {
    id: "rel-1",
    tenantId: "tenant-1",
    ecoId: "eco-1",
    ecoNumber: "ECO-0042",
    name: "ECO-0042 release",
    releasedAt: "2026-09-01T00:00:00.000Z",
    releasedById: "user-1",
    note: null,
    manifest: { parts: [], files, boms: [] },
  };
}

async function unzip(stream: ReadableStream<Uint8Array>) {
  const files = unzipSync(await readAll(stream));
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]));
}

describe("buildReleaseZipStream", () => {
  it("zips the release's files with a manifest", async () => {
    vault.blobs.set("tenant-1/f1", strToU8("drawing"));
    const files = await unzip(
      buildReleaseZipStream(release([releaseFile("f1", "DWG-001.pdf")]), vault.client)
    );
    expect(Object.keys(files)).toEqual(["DWG-001.pdf", "manifest.json"]);
    expect(files["DWG-001.pdf"]).toBe("drawing");
    const manifest = JSON.parse(files["manifest.json"]);
    expect(manifest).toMatchObject({ releaseId: "rel-1", ecoNumber: "ECO-0042" });
    expect(manifest.unavailable).toBeUndefined();
  });

  it("names a file it could not fetch in MISSING.txt and in the manifest", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vault.blobs.set("tenant-1/f1", strToU8("drawing"));
    // tenant-1/f2 is not in storage.

    const files = await unzip(
      buildReleaseZipStream(
        release([releaseFile("f1", "DWG-001.pdf"), releaseFile("f2", "MODEL-001.step")]),
        vault.client
      )
    );

    expect(Object.keys(files)).toEqual(["DWG-001.pdf", "MISSING.txt", "manifest.json"]);
    expect(files["MISSING.txt"]).toContain("MODEL-001.step");
    expect(JSON.parse(files["manifest.json"]).unavailable).toEqual(["MODEL-001.step"]);
  });

  it("renames a release file called manifest.json rather than the manifest", async () => {
    vault.blobs.set("tenant-1/f1", strToU8("user data"));
    const files = await unzip(
      buildReleaseZipStream(release([releaseFile("f1", "manifest.json")]), vault.client)
    );
    expect(files["f1-manifest.json"]).toBe("user data");
    expect(JSON.parse(files["manifest.json"]).releaseId).toBe("rel-1");
  });
});
