import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { unzipSync, strFromU8, strToU8 } from "fflate";
import {
  buildStorageZipStream,
  planVaultZip,
  MAX_DOWNLOAD_BYTES,
  MAX_DOWNLOAD_FILES,
  ZIP_MAX_DURATION_SECONDS,
  type ZipEntry,
} from "./vault-zip";
import { openScope, type FolderAccessScope } from "./folder-access";
import { IN_FILTER_CHUNK } from "./paged-query";
import { createFakeVault, readAll, type FakeVault } from "./__mocks__/fake-vault";

/**
 * Every zip the app serves goes through `buildStorageZipStream`, and every
 * vault selection or folder is sized and authorized by `planVaultZip`. The
 * defects these pin down all shipped the same way — a download that looked
 * like it worked:
 *
 *   - files that could not be fetched vanished with no trace in the archive;
 *   - the whole archive was pushed into memory as fast as storage delivered;
 *   - archives past the zip format's 4 GB and the function's 300 s were offered;
 *   - reads past PostgREST's 1,000-row cap dropped files silently.
 */

const TENANT = "tenant-1";

let vault: FakeVault;

beforeEach(() => {
  vault = createFakeVault();
  vi.stubGlobal("fetch", vault.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function store(key: string, text: string) {
  vault.blobs.set(key, strToU8(text));
}

function entry(name: string, key = `k/${name}`, sizeBytes?: number): ZipEntry {
  return { entryName: name, storageKey: key, sizeBytes };
}

async function unzip(stream: ReadableStream<Uint8Array>): Promise<Record<string, string>> {
  const files = unzipSync(await readAll(stream));
  return Object.fromEntries(Object.entries(files).map(([name, data]) => [name, strFromU8(data)]));
}

/** A body that hands out `chunks` chunks on demand and records how many it produced. */
function meteredBody(chunks: number, chunkSize = 64 * 1024) {
  const meter = { produced: 0, cancelled: false };
  const make = () =>
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (meter.produced >= chunks) return controller.close();
          meter.produced++;
          controller.enqueue(new Uint8Array(chunkSize).fill(meter.produced % 251));
        },
        cancel() {
          meter.cancelled = true;
        },
      },
      { highWaterMark: 0 }
    );
  return { meter, make };
}

// ─── The stream ───────────────────────────────────────────────────────────

describe("buildStorageZipStream", () => {
  it("streams every file into an archive that opens", async () => {
    store("k/a.txt", "alpha");
    store("k/b.txt", "bravo");
    const files = await unzip(
      buildStorageZipStream(vault.client, {
        entries: [entry("a.txt"), entry("Drawings/b.txt", "k/b.txt")],
        logLabel: "test",
      })
    );
    expect(files).toEqual({ "a.txt": "alpha", "Drawings/b.txt": "bravo" });
  });

  it("names every file it could not include in MISSING.txt, and logs them", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    store("k/ok.pdf", "fine");
    vault.unsignable.add("k/unsigned.pdf"); // storage will not sign it
    // k/gone.pdf signs, but the object answers 404

    const files = await unzip(
      buildStorageZipStream(vault.client, {
        entries: [entry("ok.pdf"), entry("unsigned.pdf"), entry("gone.pdf")],
        logLabel: "folder f-1",
      })
    );

    expect(Object.keys(files).sort()).toEqual(["MISSING.txt", "ok.pdf"]);
    expect(files["MISSING.txt"]).toContain("2 of 3 file(s) could not be included");
    expect(files["MISSING.txt"]).toContain("unsigned.pdf  (storage could not provide it)");
    expect(files["MISSING.txt"]).toContain("gone.pdf  (storage answered HTTP 404)");
    expect(files["MISSING.txt"]).not.toContain("k/"); // storage keys stay internal

    expect(warn).toHaveBeenCalledWith(
      "[zip] folder f-1: 2 of 3 file(s) left out",
      expect.arrayContaining([
        expect.objectContaining({ storageKey: "k/unsigned.pdf" }),
        expect.objectContaining({ storageKey: "k/gone.pdf" }),
      ])
    );
  });

  it("writes no MISSING.txt when nothing is missing", async () => {
    store("k/a.txt", "alpha");
    const files = await unzip(
      buildStorageZipStream(vault.client, { entries: [entry("a.txt")], logLabel: "test" })
    );
    expect(files["MISSING.txt"]).toBeUndefined();
  });

  it("renames its report rather than overwrite a file already called MISSING.txt", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    store("k/MISSING.txt", "the user's own file");
    const files = await unzip(
      buildStorageZipStream(vault.client, {
        entries: [entry("MISSING.txt"), entry("gone.pdf")],
        logLabel: "test",
      })
    );
    expect(files["MISSING.txt"]).toBe("the user's own file");
    expect(files["MISSING (2).txt"]).toContain("gone.pdf");
  });

  /**
   * The pull-based guarantee. The old builder fetched and pushed every file
   * in `start()`, so a slow client left the whole archive in function memory.
   */
  it("fetches nothing until read, and one file for the first chunk", async () => {
    for (const name of ["a", "b", "c"]) store(`k/${name}`, name.repeat(100));
    const stream = buildStorageZipStream(vault.client, {
      entries: [entry("a"), entry("b"), entry("c")],
      logLabel: "test",
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(vault.fetched).toEqual([]);
    expect(vault.signBatches).toEqual([]);

    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(vault.fetched.length).toBeLessThanOrEqual(1);
    await reader.cancel();
  });

  it("pulls a large file from storage no faster than the consumer reads it", async () => {
    const { meter, make } = meteredBody(10_000); // ~640 MB if drained
    vault.blobs.set("k/big.step", make);

    const reader = buildStorageZipStream(vault.client, {
      entries: [entry("big.step")],
      logLabel: "test",
    }).getReader();

    for (let i = 0; i < 5; i++) await reader.read();
    await new Promise((r) => setTimeout(r, 10));
    expect(meter.produced).toBeLessThanOrEqual(8);

    // And a consumer that goes away closes the storage read.
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 0));
    expect(meter.cancelled).toBe(true);
  });

  it("closes the storage read cleanly when the browser goes away mid-read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let storageCancelled = false;
    // Storage has sent headers but no bytes yet, and never will on its own.
    vault.blobs.set(
      "k/slow.step",
      () =>
        new ReadableStream<Uint8Array>({
          pull: () => new Promise(() => undefined),
          cancel() {
            storageCancelled = true;
          },
        })
    );

    const reader = buildStorageZipStream(vault.client, {
      entries: [entry("slow.step")],
      logLabel: "test",
    }).getReader();
    const pending = reader.read();
    await new Promise((r) => setTimeout(r, 10));
    await reader.cancel("user aborted");

    expect(await pending).toEqual({ done: true, value: undefined });
    await new Promise((r) => setTimeout(r, 10));
    expect(storageCancelled).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });

  it("signs links in batches rather than one storage call per file", async () => {
    const entries = Array.from({ length: 120 }, (_, i) => {
      store(`k/${i}`, String(i));
      return entry(`f${i}.txt`, `k/${i}`);
    });
    const files = await unzip(buildStorageZipStream(vault.client, { entries, logLabel: "test" }));
    expect(Object.keys(files)).toHaveLength(120);
    expect(vault.signBatches.map((b) => b.length)).toEqual([50, 50, 20]);
  });

  it("stops starting files near the time limit, and still closes a valid archive", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const name of ["b", "c"]) store(`k/${name}`, name);
    let clock = 0;
    // The first file takes until the function is nearly out of time.
    vault.blobs.set(
      "k/a",
      () =>
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(strToU8("a"));
            controller.close();
            clock = (ZIP_MAX_DURATION_SECONDS - 5) * 1000;
          },
        })
    );

    const files = await unzip(
      buildStorageZipStream(vault.client, {
        entries: [entry("a"), entry("b"), entry("c")],
        logLabel: "test",
        now: () => clock,
      })
    );

    expect(files.a).toBe("a");
    expect(files.b).toBeUndefined();
    expect(files["MISSING.txt"]).toContain("b  (the download ran out of time before reaching it)");
    expect(files["MISSING.txt"]).toContain("c  (the download ran out of time before reaching it)");
  });

  it("leaves out a file that would take the archive past the 4 GB zip limit", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    store("k/small", "small");
    store("k/declared-huge", "tiny body, huge header");
    vault.declaredLengths.set("k/declared-huge", 4 * 1024 ** 3);

    const files = await unzip(
      buildStorageZipStream(vault.client, {
        entries: [
          entry("known-huge.sldasm", "k/known-huge", 5 * 1024 ** 3), // size known up front
          entry("declared-huge.sldasm", "k/declared-huge"), // size learned from storage
          entry("small"),
        ],
        logLabel: "test",
      })
    );

    expect(files.small).toBe("small");
    expect(files["MISSING.txt"]).toContain("known-huge.sldasm  (it would take the archive past");
    expect(files["MISSING.txt"]).toContain("declared-huge.sldasm  (it would take the archive past");
    // The known-huge file was refused before anyone asked storage for it.
    expect(vault.fetched).not.toContain("k/known-huge");
  });

  it("fails the download when a file breaks partway, rather than zip a truncated copy", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vault.blobs.set(
      "k/broken.sldprt",
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(1024));
            controller.error(new Error("connection reset"));
          },
        })
    );
    await expect(
      readAll(
        buildStorageZipStream(vault.client, {
          entries: [entry("broken.sldprt")],
          logLabel: "test",
        })
      )
    ).rejects.toThrow("connection reset");
  });

  it("hands the trailer what made it in, and writes its entries last", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    store("k/a", "a");
    const trailer = vi.fn(() => [{ entryName: "manifest.json", text: "{}" }]);
    const files = await unzip(
      buildStorageZipStream(vault.client, {
        entries: [entry("a"), entry("b")],
        logLabel: "test",
        trailer,
      })
    );
    expect(trailer).toHaveBeenCalledWith({
      included: [expect.objectContaining({ entryName: "a" })],
      missing: [expect.objectContaining({ entry: expect.objectContaining({ entryName: "b" }) })],
    });
    expect(Object.keys(files)).toEqual(["a", "MISSING.txt", "manifest.json"]);
  });
});

// ─── Planning ─────────────────────────────────────────────────────────────

const deny = (allowed: string[]): FolderAccessScope => ({
  ...openScope(),
  restrictedAny: true,
  allowed: new Set(allowed),
});

function file(
  id: string,
  folderId: string,
  name: string,
  currentVersion = 1
): Record<string, unknown> {
  return { id, tenantId: TENANT, folderId, name, currentVersion, deletedAt: null };
}

function version(fileId: string, v: number, fileSize = 10): Record<string, unknown> {
  return {
    id: `${fileId}-v${String(v).padStart(3, "0")}`,
    fileId,
    version: v,
    storageKey: `${TENANT}/${fileId}/v${v}`,
    fileSize,
  };
}

describe("planVaultZip — a selection of files", () => {
  it("resolves the current version of each visible file in the caller's tenant", async () => {
    vault.tables.files = [
      file("f1", "open", "a.pdf", 2),
      file("f2", "secret", "b.pdf"),
      { ...file("f3", "open", "c.pdf"), tenantId: "tenant-2" },
      { ...file("f4", "open", "d.pdf"), deletedAt: "2026-09-01" },
    ];
    vault.tables.file_versions = [
      version("f1", 1),
      version("f1", 2, 20),
      version("f2", 1),
      version("f3", 1),
    ];

    const plan = await planVaultZip(vault.client, TENANT, deny(["open"]), {
      kind: "files",
      fileIds: ["f1", "f2", "f3", "f4"],
    });

    expect(plan).toMatchObject({
      ok: true,
      entries: [{ entryName: "a.pdf", storageKey: `${TENANT}/f1/v2`, sizeBytes: 20 }],
      totalBytes: 20,
      skipped: 3,
    });
  });

  it("refuses more files than one zip can hold before reading anything", async () => {
    const fileIds = Array.from({ length: MAX_DOWNLOAD_FILES + 1 }, (_, i) => `f${i}`);
    const plan = await planVaultZip(vault.client, TENANT, openScope(), { kind: "files", fileIds });

    expect(plan).toMatchObject({ ok: false, status: 413 });
    if (plan.ok) throw new Error("unreachable");
    expect(plan.message).toBe(
      "This selection has 1,001 files, and one zip can hold at most 1,000. Select fewer files, or download a subfolder instead."
    );
    expect(vault.reads).toEqual([]);
  });

  it("refuses a selection larger than one zip can be, and says how large it is", async () => {
    vault.tables.files = [
      file("f1", "d", "a.sldasm"),
      file("f2", "d", "b.sldasm"),
      file("f3", "d", "c.sldasm"),
    ];
    const each = 400 * 1024 * 1024;
    vault.tables.file_versions = ["f1", "f2", "f3"].map((id) => version(id, 1, each));

    const plan = await planVaultZip(vault.client, TENANT, openScope(), {
      kind: "files",
      fileIds: ["f1", "f2", "f3"],
    });

    expect(plan).toMatchObject({
      ok: false,
      status: 413,
      details: { totalBytes: 3 * each, maxBytes: MAX_DOWNLOAD_BYTES, fileCount: 3 },
    });
    if (plan.ok) throw new Error("unreachable");
    expect(plan.message).toBe(
      "This selection is 1.2 GB, and one zip can be at most 1 GB. Select fewer files, or download a subfolder instead."
    );
  });

  it("404s a selection with nothing the caller can download", async () => {
    vault.tables.files = [file("f1", "secret", "a.pdf")];
    vault.tables.file_versions = [version("f1", 1)];
    const plan = await planVaultZip(vault.client, TENANT, deny([]), {
      kind: "files",
      fileIds: ["f1"],
    });
    expect(plan).toMatchObject({ ok: false, status: 404 });
  });

  it("pages every read, and never puts more than a chunk of ids in one .in()", async () => {
    // A project whose max-rows is set low: an unpaged read would stop at 40.
    vault = createFakeVault({ maxRows: 40 });
    const ids = Array.from({ length: 500 }, (_, i) => `f${String(i).padStart(3, "0")}`);
    vault.tables.files = ids.map((id) => file(id, "d", `${id}.pdf`));
    vault.tables.file_versions = ids.map((id) => version(id, 1));

    const plan = await planVaultZip(vault.client, TENANT, openScope(), {
      kind: "files",
      fileIds: ids,
    });

    expect(plan.ok && plan.entries).toHaveLength(500);
    expect(Math.max(...vault.inSizes)).toBeLessThanOrEqual(IN_FILTER_CHUNK);
  });

  it("finds the current version even when a chunk's versions run past 1,000 rows", async () => {
    // 100 files x 12 versions = 1,200 version rows in one chunk, current last.
    const ids = Array.from({ length: 100 }, (_, i) => `f${String(i).padStart(3, "0")}`);
    vault.tables.files = ids.map((id) => file(id, "d", `${id}.pdf`, 12));
    vault.tables.file_versions = ids.flatMap((id) =>
      Array.from({ length: 12 }, (_, v) => version(id, v + 1))
    );

    const plan = await planVaultZip(vault.client, TENANT, openScope(), {
      kind: "files",
      fileIds: ids,
    });

    expect(plan.ok && plan.entries).toHaveLength(100);
    expect(plan.ok && plan.entries.every((e) => e.storageKey.endsWith("/v12"))).toBe(true);
  });
});

describe("planVaultZip — a folder", () => {
  function folder(id: string, path: string): Record<string, unknown> {
    return { id, tenantId: TENANT, name: path.split("/").pop(), path };
  }

  it("keeps the hierarchy inside the archive, below the folder's own name", async () => {
    vault.tables.folders = [
      folder("root", "/Projects/Widget-X"),
      folder("dwg", "/Projects/Widget-X/Drawings"),
      folder("sibling", "/Projects/Widget-XL"), // matched by the LIKE, not a descendant
    ];
    vault.tables.files = [
      file("f1", "root", "readme.txt"),
      file("f2", "dwg", "bracket.pdf"),
      file("f3", "sibling", "other.pdf"),
    ];
    vault.tables.file_versions = [version("f1", 1), version("f2", 1), version("f3", 1)];

    const plan = await planVaultZip(vault.client, TENANT, openScope(), {
      kind: "folder",
      folderId: "root",
    });

    expect(plan.ok && plan.entries.map((e) => e.entryName)).toEqual([
      "Widget-X/Drawings/bracket.pdf",
      "Widget-X/readme.txt",
    ]);
    expect(plan.ok && plan.zipName).toBe("Widget-X");
  });

  it("refuses a folder the caller cannot see, and drops subfolders they cannot", async () => {
    vault.tables.folders = [folder("root", "/P"), folder("hidden", "/P/Hidden")];
    vault.tables.files = [file("f1", "root", "a.pdf"), file("f2", "hidden", "b.pdf")];
    vault.tables.file_versions = [version("f1", 1), version("f2", 1)];

    expect(
      await planVaultZip(vault.client, TENANT, deny([]), { kind: "folder", folderId: "root" })
    ).toMatchObject({ ok: false, status: 403 });

    const plan = await planVaultZip(vault.client, TENANT, deny(["root"]), {
      kind: "folder",
      folderId: "root",
    });
    expect(plan.ok && plan.entries.map((e) => e.entryName)).toEqual(["P/a.pdf"]);
  });

  it("404s a folder in another tenant", async () => {
    vault.tables.folders = [{ ...folder("root", "/P"), tenantId: "tenant-2" }];
    expect(
      await planVaultZip(vault.client, TENANT, openScope(), { kind: "folder", folderId: "root" })
    ).toMatchObject({ ok: false, status: 404 });
  });

  it("reads past 1,000 descendant folders instead of silently dropping the rest", async () => {
    const subfolders = Array.from({ length: 1500 }, (_, i) =>
      folder(`sub-${String(i).padStart(4, "0")}`, `/P/Sub-${i}`)
    );
    vault.tables.folders = [folder("root", "/P"), ...subfolders];
    // Files only in folders that sort past the first 1,000 rows.
    vault.tables.files = subfolders
      .slice(1400)
      .map((f, i) => file(`f${i}`, f.id as string, "x.pdf"));
    vault.tables.file_versions = vault.tables.files.map((f) => version(f.id as string, 1));

    const plan = await planVaultZip(vault.client, TENANT, openScope(), {
      kind: "folder",
      folderId: "root",
    });

    expect(plan.ok && plan.entries).toHaveLength(100);
  });

  it("refuses a folder with too many files before reading every version", async () => {
    vault.tables.folders = [folder("root", "/Big")];
    vault.tables.files = Array.from({ length: MAX_DOWNLOAD_FILES + 1 }, (_, i) =>
      file(`f${i}`, "root", `${i}.pdf`)
    );

    const plan = await planVaultZip(vault.client, TENANT, openScope(), {
      kind: "folder",
      folderId: "root",
    });

    expect(plan).toMatchObject({ ok: false, status: 413 });
    if (plan.ok) throw new Error("unreachable");
    expect(plan.message).toBe(
      "This folder has 1,001 files, and one zip can hold at most 1,000. Download its subfolders one at a time instead."
    );
    expect(vault.reads).not.toContain("file_versions");
  });
});
