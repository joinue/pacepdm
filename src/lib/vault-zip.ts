// Server-side streaming zips of vault files.
//
// Every zip the app serves — a vault selection, a folder, a release package, a
// part package — is built by `buildStorageZipStream` below, so the limits and
// the missing-file report behave the same everywhere.
//
// How a vault selection or folder reaches the browser
// ───────────────────────────────────────────────────
//   1. POST …/prepare (fetchJson) plans the zip under the caller's tenant and
//      folder access, and refuses it with a readable message when it is empty,
//      forbidden, or over the limits below. It mints nothing.
//   2. The browser submits a hidden <form method="POST"> to …/zip carrying the
//      same selection. That route plans the zip again — session, tenant and
//      folder access as of now — and streams it with
//      `Content-Disposition: attachment`, so the browser saves it without
//      leaving the page.
//
// It used to sign every entry's storage key and zip path into a token and send
// the browser to GET /zip/<token>. At ~260 bytes a file, fifty files passed the
// 14–16 KB URL and header limits and the download died with a 414 or 431. A
// form body has no such limit, the URL is the same for two files or a thousand,
// and there is no bearer token left to leak or replay: the session is the
// credential, checked at the moment the bytes go out.

import type { SupabaseClient } from "@supabase/supabase-js";
import { Zip, ZipPassThrough } from "fflate";
import { filterViewable, type FolderAccessScope } from "./folder-access";
import { selectAll, selectAllIn } from "./paged-query";

// ─── Limits ───────────────────────────────────────────────────────────────

/**
 * How long a zip route may run. Each zip route exports `maxDuration = 300` as a
 * literal — Next reads segment config statically, so it cannot import this.
 * Keep them in step.
 */
export const ZIP_MAX_DURATION_SECONDS = 300;

/**
 * The largest vault zip on offer: 1 GiB.
 *
 * Two ceilings sit above it, and a download that hits either one still looks
 * like it worked until someone tries to open it:
 *
 *   - **The zip format.** fflate 0.8 writes plain zip, never Zip64, so every
 *     size and offset is 32 bits and an archive that reaches 4 GiB is corrupt.
 *   - **The function's 300 seconds.** The stream is pull-based, so bytes leave
 *     no faster than the browser takes them, and a zip cut off at 300 s has no
 *     central directory. A full-size zip — 1 GiB across 1,000 files, with up
 *     to ~100 s of that spent on per-file round trips — needs roughly 45 Mbit/s
 *     sustained to finish. 2 GiB would need ~90.
 *
 * Refusing at prepare, with a suggestion, beats a file that will not open.
 */
export const MAX_DOWNLOAD_BYTES = 1024 ** 3;

/**
 * The most files in one vault zip. Every file costs a storage round trip before
 * its first byte arrives (~50–100 ms; links are signed in batches), so 1,000
 * files can spend ~100 s of the 300 on round trips alone.
 */
export const MAX_DOWNLOAD_FILES = 1000;

/** The name of the report written into any archive that is missing files. */
export const MISSING_ENTRY_NAME = "MISSING.txt";

// Backstops inside the stream itself. Release and part zips have no prepare
// step to refuse them up front, and a vault zip can still run slow, so the
// stream never starts a file it cannot finish inside the format and the clock:
// what it skips goes into MISSING.txt, and the archive stays valid.

/** Plain zip's 32-bit ceiling on sizes and offsets. */
const ZIP32_MAX_BYTES = 0xffffffff;
/** Plain zip counts entries in 16 bits. */
const ZIP32_MAX_ENTRIES = 0xffff;
/** Held back for MISSING.txt, manifests and the central directory's end record. */
const TRAILER_RESERVE_BYTES = 16 * 1024 * 1024;
const TRAILER_RESERVE_ENTRIES = 8;
/** No new file is started this close to maxDuration, so the archive can still close. */
const DEADLINE_MARGIN_SECONDS = 30;
/** Links are signed this many at a time: one storage call per batch, not per file. */
const SIGN_BATCH = 50;
/** Outlives the function, so a link signed at the start is still good at the end. */
const SIGNED_URL_TTL_SECONDS = ZIP_MAX_DURATION_SECONDS + 60;

// ─── The stream ───────────────────────────────────────────────────────────

export interface ZipEntry {
  /** Path inside the archive ("Drawings/widget.pdf"). Unique within it. */
  entryName: string;
  /** Supabase storage key in the `vault` bucket. */
  storageKey: string;
  /** From file_versions, when known. Lets the stream skip a file up front. */
  sizeBytes?: number;
}

export interface ZipOutcome {
  included: ZipEntry[];
  missing: { entry: ZipEntry; reason: string }[];
}

export interface ZipTextEntry {
  entryName: string;
  text: string;
}

export interface StorageZipOptions {
  entries: ZipEntry[];
  /**
   * Text entries written after the files, once it is known which of them made
   * it in — a manifest that records what is actually in the archive.
   */
  trailer?: (outcome: ZipOutcome) => ZipTextEntry[];
  /** Names the archive in server logs: "release <id>", "folder <id>". */
  logLabel: string;
  /** Clock, for tests. */
  now?: () => number;
}

/** Anything carrying a storage client: the raw client or the scoped `db`. */
export type StorageSource = Pick<SupabaseClient, "storage">;

type Signed = { ok: true; url: string } | { ok: false; error: string };

/**
 * Signs storage links in batches, starting at the file about to be fetched, so
 * a thousand-file zip costs twenty storage calls rather than a thousand — and a
 * consumer that stops early never causes links to be signed for files it will
 * not reach.
 */
function batchSigner(storage: SupabaseClient["storage"], keys: string[]) {
  const ready = new Map<number, Signed>();

  return async function sign(index: number): Promise<Signed> {
    if (!ready.has(index)) {
      const batch = keys.slice(index, index + SIGN_BATCH);
      const { data, error } = await storage
        .from("vault")
        .createSignedUrls(batch, SIGNED_URL_TTL_SECONDS);

      if (error || !data) {
        // A failed batch should cost at most this file, not fifty. Sign it on
        // its own; the next file starts a fresh batch.
        const single = await storage
          .from("vault")
          .createSignedUrl(keys[index], SIGNED_URL_TTL_SECONDS);
        if (single.error || !single.data) {
          return { ok: false, error: single.error?.message ?? error?.message ?? "no signed URL" };
        }
        return { ok: true, url: single.data.signedUrl };
      }

      const byPath = new Map(data.map((d) => [d.path, d]));
      batch.forEach((key, i) => {
        const d = data[i]?.path === key ? data[i] : byPath.get(key);
        ready.set(
          index + i,
          d && !d.error && d.signedUrl
            ? { ok: true, url: d.signedUrl }
            : { ok: false, error: d?.error ?? "no signed URL returned" }
        );
      });
    }

    const result = ready.get(index)!;
    ready.delete(index);
    return result;
  };
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** "MISSING.txt" → "MISSING (2).txt" when a vault file already has the name. */
function reserveName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; ; i++) {
    const alt = `${base} (${i})${ext}`;
    if (!used.has(alt)) {
      used.add(alt);
      return alt;
    }
  }
}

function missingReport(outcome: ZipOutcome, total: number, at: number): string {
  const lines = [
    "SOME FILES ARE NOT IN THIS ARCHIVE.",
    "",
    `${outcome.missing.length} of ${total} file(s) could not be included:`,
    "",
    ...outcome.missing.map(({ entry, reason }) => `  ${entry.entryName}  (${reason})`),
    "",
    "Every other file in the archive is complete. Download the missing ones",
    "individually or try the zip again. If a file is missing every time, tell",
    "whoever manages the vault: its stored copy may be gone.",
    "",
    `Generated ${new Date(at).toISOString()} by PACE PDM.`,
    "",
  ];
  return lines.join("\r\n");
}

/**
 * Stream a zip of vault files, fetching each one only when the consumer is ready
 * for more.
 *
 * Pull-based: nothing is signed or fetched until the response body is read, and
 * each read advances the archive by at most one storage read. If the browser
 * downloads slower than storage delivers, the storage connection waits instead
 * of the archive piling up in function memory — which is what the old
 * push-everything-in-`start()` version did.
 *
 * A file that cannot be signed or fetched, or that would push the archive past
 * the zip format or the time limit, is left out and named in MISSING.txt, and
 * the omission is logged. A file that fails *partway* errors the whole
 * download instead: its header is already sent, and a quietly truncated drawing
 * inside a zip that opens cleanly is worse than a download the browser reports
 * as failed.
 */
export function buildStorageZipStream(
  source: StorageSource,
  options: StorageZipOptions
): ReadableStream<Uint8Array> {
  const { entries, trailer, logLabel } = options;
  const now = options.now ?? Date.now;
  const stopStartingAt = now() + (ZIP_MAX_DURATION_SECONDS - DEADLINE_MARGIN_SECONDS) * 1000;
  const sign = batchSigner(
    source.storage,
    entries.map((e) => e.storageKey)
  );

  // fflate calls back synchronously from push() and end(); its output waits
  // here until the consumer pulls it.
  const out: Uint8Array[] = [];
  const state = { finished: false, cancelled: false, failure: null as Error | null };
  let bytesOut = 0;
  let directoryBytes = 22; // end-of-central-directory record
  let entryCount = 0;

  const zip = new Zip((err, data, final) => {
    if (err) {
      state.failure = err;
      return;
    }
    if (data && data.length > 0) {
      out.push(data);
      bytesOut += data.length;
    }
    if (final) state.finished = true;
  });

  const outcome: ZipOutcome = { included: [], missing: [] };
  const logged: { storageKey: string; entryName: string; reason: string }[] = [];
  const usedNames = new Set(entries.map((e) => e.entryName));
  let nextIndex = 0;
  let closing = false;
  let current: {
    entry: ZipEntry;
    file: ZipPassThrough;
    reader: ReadableStreamDefaultReader<Uint8Array>;
  } | null = null;

  const addEntry = (name: string): ZipPassThrough => {
    const file = new ZipPassThrough(name);
    zip.add(file);
    entryCount++;
    directoryBytes += 46 + utf8Length(name);
    return file;
  };

  const miss = (entry: ZipEntry, reason: string, detail?: string) => {
    outcome.missing.push({ entry, reason });
    logged.push({
      storageKey: entry.storageKey,
      entryName: entry.entryName,
      reason: detail ? `${reason}: ${detail}` : reason,
    });
  };

  /** Why this file must not be started, or null if it may. */
  const refusal = (entry: ZipEntry, size: number | undefined): string | null => {
    if (entryCount + TRAILER_RESERVE_ENTRIES >= ZIP32_MAX_ENTRIES) {
      return "the archive reached the zip format's file-count limit";
    }
    if (now() >= stopStartingAt) return "the download ran out of time before reaching it";
    if (size !== undefined && Number.isFinite(size)) {
      const name = utf8Length(entry.entryName);
      const after =
        bytesOut +
        (30 + name + size + 16) + // local header, data, data descriptor
        directoryBytes +
        (46 + name) + // its central directory record
        TRAILER_RESERVE_BYTES;
      if (after > ZIP32_MAX_BYTES) return "it would take the archive past the 4 GB zip limit";
    }
    return null;
  };

  const openNext = async () => {
    const entry = entries[nextIndex];
    const index = nextIndex++;

    const early = refusal(entry, entry.sizeBytes);
    if (early) return miss(entry, early);

    const signed = await sign(index);
    if (state.cancelled) return;
    if (!signed.ok) return miss(entry, "storage could not provide it", signed.error);

    let response: Response;
    try {
      response = await fetch(signed.url);
    } catch (err) {
      return miss(entry, "storage could not be reached", String(err));
    }
    if (state.cancelled) {
      await response.body?.cancel();
      return;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return miss(entry, `storage answered HTTP ${response.status}`);
    }

    const length = response.headers.get("content-length");
    const late = length === null ? null : refusal(entry, Number(length));
    if (late) {
      await response.body.cancel();
      return miss(entry, late);
    }

    current = { entry, file: addEntry(entry.entryName), reader: response.body.getReader() };
  };

  const finish = () => {
    const extras: ZipTextEntry[] = [];
    if (outcome.missing.length > 0) {
      console.warn(
        `[zip] ${logLabel}: ${outcome.missing.length} of ${entries.length} file(s) left out`,
        logged.slice(0, 50)
      );
      extras.push({
        entryName: MISSING_ENTRY_NAME,
        text: missingReport(outcome, entries.length, now()),
      });
    }
    extras.push(...(trailer?.(outcome) ?? []));

    const encoder = new TextEncoder();
    for (const extra of extras) {
      addEntry(reserveName(extra.entryName, usedNames)).push(encoder.encode(extra.text), true);
    }
    zip.end();
  };

  /** One step: a storage read into the open entry, the next file, or the end. */
  const advance = async () => {
    const open = current;
    if (open) {
      const { done, value } = await open.reader.read();
      // The browser went away mid-read; `cancel` has already cleaned up.
      if (state.cancelled) return;
      if (done) {
        open.file.push(new Uint8Array(0), true);
        outcome.included.push(open.entry);
        current = null;
      } else if (value && value.length > 0) {
        open.file.push(value, false);
        // Only reachable when storage sent more than it declared.
        if (bytesOut + directoryBytes > ZIP32_MAX_BYTES) {
          throw new Error(`${open.entry.entryName} took the archive past the 4 GB zip limit`);
        }
      }
      return;
    }
    if (nextIndex < entries.length) return openNext();
    if (closing) throw new Error("the zip did not finish after its last entry");
    closing = true;
    finish();
  };

  const abandon = (reason: unknown) => {
    const reader = current?.reader;
    current = null;
    zip.terminate();
    reader?.cancel(reason).catch((err) => {
      console.warn(`[zip] ${logLabel}: could not cancel a storage read`, err);
    });
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          while (out.length === 0 && !state.finished && !state.cancelled) {
            await advance();
            if (state.failure) throw state.failure;
          }
          if (state.cancelled) return;
          for (const chunk of out.splice(0)) controller.enqueue(chunk);
          if (state.finished) controller.close();
        } catch (err) {
          if (state.cancelled) return;
          console.error(`[zip] ${logLabel}: stream failed`, err);
          abandon(err);
          controller.error(err);
        }
      },
      cancel(reason) {
        state.cancelled = true;
        abandon(reason);
      },
    },
    // Pull only when the consumer asks. The default of one chunk would fetch
    // ahead of a reader that never comes back.
    { highWaterMark: 0 }
  );
}

/** The response every vault zip route sends. */
export function zipResponse(stream: ReadableStream<Uint8Array>, filename: string): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // A zip stream has no length up front and cannot be replayed.
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

/**
 * A zip is started by a form POST, which a page on another site can also
 * submit. The session cookie is SameSite=Lax, so that POST arrives without it
 * and fails auth anyway; this refuses it before any work, on every browser
 * that says where a request came from.
 */
export function isCrossSiteRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  return site !== null && site !== "same-origin";
}

// ─── Planning a vault zip ─────────────────────────────────────────────────

interface FileRow {
  id: string;
  name: string;
  folderId: string;
  currentVersion: number;
}

interface VersionRow {
  fileId: string;
  version: number;
  storageKey: string;
  fileSize: number | null;
}

export type VaultZipRequest =
  { kind: "files"; fileIds: string[] } | { kind: "folder"; folderId: string };

export type VaultZipPlan =
  | {
      ok: true;
      entries: ZipEntry[];
      totalBytes: number;
      /** Suggested download name, without extension. */
      zipName: string;
      /** Requested files that no longer exist or are not visible to the caller. */
      skipped: number;
    }
  | { ok: false; status: 403 | 404 | 413; message: string; details?: Record<string, number> };

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 ? n.toFixed(0) : n.toFixed(1).replace(/\.0$/, "")} ${units[i]}`;
}

function overLimit(
  kind: VaultZipRequest["kind"],
  fileCount: number,
  totalBytes: number
): VaultZipPlan | null {
  const what = kind === "folder" ? "This folder" : "This selection";
  const instead =
    kind === "folder"
      ? "Download its subfolders one at a time instead."
      : "Select fewer files, or download a subfolder instead.";
  const details = {
    fileCount,
    totalBytes,
    maxFiles: MAX_DOWNLOAD_FILES,
    maxBytes: MAX_DOWNLOAD_BYTES,
  };

  if (fileCount > MAX_DOWNLOAD_FILES) {
    return {
      ok: false,
      status: 413,
      message: `${what} has ${fileCount.toLocaleString("en-US")} files, and one zip can hold at most ${MAX_DOWNLOAD_FILES.toLocaleString("en-US")}. ${instead}`,
      details,
    };
  }
  if (totalBytes > MAX_DOWNLOAD_BYTES) {
    return {
      ok: false,
      status: 413,
      message: `${what} is ${formatBytes(totalBytes)}, and one zip can be at most ${formatBytes(MAX_DOWNLOAD_BYTES)}. ${instead}`,
      details,
    };
  }
  return null;
}

/**
 * Current-version rows for these files, every page of them. Over-fetches every
 * version of each file and picks the current one in JS: one paged read instead
 * of a lookup per file.
 */
async function currentVersions(
  db: SupabaseClient,
  files: FileRow[]
): Promise<Map<string, VersionRow>> {
  // file_versions has no tenantId of its own; `files` was read under the
  // tenant filter, so these ids are the caller's.
  const rows = await selectAllIn<VersionRow>(
    files.map((f) => f.id),
    (chunk, from, to) =>
      db
        .from("file_versions")
        .select("fileId, version, storageKey, fileSize")
        .in("fileId", chunk)
        .order("id")
        .range(from, to)
  );
  const current = new Map(files.map((f) => [f.id, f.currentVersion]));
  const byFile = new Map<string, VersionRow>();
  for (const v of rows) {
    if (current.get(v.fileId) === v.version) byFile.set(v.fileId, v);
  }
  return byFile;
}

/**
 * Resolve a selection of file ids into zip entries: tenant-scoped, filtered by
 * folder access, current version only. Duplicate names get the file id
 * prepended, because zips with duplicate entry paths confuse some extractors.
 */
async function planFiles(
  db: SupabaseClient,
  tenantId: string,
  requested: string[],
  scope: FolderAccessScope
): Promise<VaultZipPlan> {
  const fileIds = [...new Set(requested)];

  // Refuse before reading anything: each id is at most one entry.
  const tooMany = overLimit("files", fileIds.length, 0);
  if (tooMany) return tooMany;

  const rows = await selectAllIn<FileRow>(fileIds, (chunk, from, to) =>
    db
      .from("files")
      .select("id, name, folderId, currentVersion")
      .in("id", chunk)
      .eq("tenantId", tenantId)
      .is("deletedAt", null)
      .order("id")
      .range(from, to)
  );
  const files = filterViewable(scope, rows, (f) => f.folderId).sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  );
  const versions = files.length > 0 ? await currentVersions(db, files) : new Map();

  // MISSING.txt sits at the root beside these, so its name is taken up front.
  const used = new Set([MISSING_ENTRY_NAME]);
  const claim = (fileId: string, raw: string): string => {
    const cleaned = raw.replace(/[\\/]/g, "_").trim() || fileId;
    if (!used.has(cleaned)) {
      used.add(cleaned);
      return cleaned;
    }
    const alt = `${fileId}-${cleaned}`;
    used.add(alt);
    return alt;
  };

  const entries: ZipEntry[] = [];
  let totalBytes = 0;
  for (const f of files) {
    const v = versions.get(f.id);
    if (!v) continue;
    entries.push({
      entryName: claim(f.id, f.name),
      storageKey: v.storageKey,
      sizeBytes: v.fileSize ?? 0,
    });
    totalBytes += v.fileSize ?? 0;
  }

  if (entries.length === 0) {
    return {
      ok: false,
      status: 404,
      message: "None of the selected files are available to download.",
    };
  }
  const tooLarge = overLimit("files", entries.length, totalBytes);
  if (tooLarge) return tooLarge;

  return {
    ok: true,
    entries,
    totalBytes,
    zipName: `vault-${new Date().toISOString().slice(0, 10)}`,
    skipped: fileIds.length - entries.length,
  };
}

/**
 * Resolve a folder into zip entries for its own files and every descendant's,
 * keeping the hierarchy so an extracted archive looks like the vault.
 *
 * Descendants come from the materialized `path` column: one paged LIKE read
 * instead of a walk.
 */
async function planFolder(
  db: SupabaseClient,
  tenantId: string,
  folderId: string,
  scope: FolderAccessScope
): Promise<VaultZipPlan> {
  const { data: root, error: rootError } = await db
    .from("folders")
    .select("id, name, path")
    .eq("id", folderId)
    .eq("tenantId", tenantId)
    .maybeSingle();
  if (rootError) throw new Error(rootError.message);
  if (!root) return { ok: false, status: 404, message: "Folder not found." };

  // `path` is slash-delimited ("/Projects/Widget-X"). A PostgREST `.or()` would
  // break on a comma in a folder name, so over-fetch with one LIKE — which can
  // match siblings (`/Foo%` matches `/Foobar`) — and tighten the boundary here.
  const rootPath = root.path as string;
  const childPrefix = rootPath === "/" ? "/" : `${rootPath}/`;
  const folderRows = (
    await selectAll<{ id: string; path: string }>((from, to) =>
      db
        .from("folders")
        .select("id, path")
        .eq("tenantId", tenantId)
        .like("path", rootPath === "/" ? "/%" : `${rootPath}%`)
        .order("id")
        .range(from, to)
    )
  ).filter((f) => f.path === rootPath || f.path.startsWith(childPrefix));

  // Checked against the caller's access as of this request. The user must be
  // able to see the root they asked for; below it, hidden folders drop out.
  const visible = filterViewable(scope, folderRows, (f) => f.id);
  const folderById = new Map(visible.map((f) => [f.id, f]));
  if (!folderById.has(root.id as string)) {
    return { ok: false, status: 403, message: "You do not have access to this folder." };
  }

  const files = await selectAllIn<FileRow>([...folderById.keys()], (chunk, from, to) =>
    db
      .from("files")
      .select("id, name, folderId, currentVersion")
      .in("folderId", chunk)
      .eq("tenantId", tenantId)
      .is("deletedAt", null)
      .order("id")
      .range(from, to)
  );

  // Refuse on count before reading every version of every file.
  const tooMany = overLimit("folder", files.length, 0);
  if (tooMany) return tooMany;

  const versions = files.length > 0 ? await currentVersions(db, files) : new Map();

  // /Projects/Widget-X/Drawings/foo.pdf → Widget-X/Drawings/foo.pdf
  const safeName = (s: string) => s.replace(/[\\/]/g, "_");
  const rootName = root.name as string;
  const located = files
    .map((f) => {
      const folder = folderById.get(f.folderId)!;
      const relative = folder.id === root.id ? "" : folder.path.slice(childPrefix.length);
      const segments = relative.split("/").filter(Boolean).map(safeName);
      return { file: f, path: [safeName(rootName), ...segments, safeName(f.name)].join("/") };
    })
    .sort((a, b) => a.path.localeCompare(b.path) || a.file.id.localeCompare(b.file.id));

  const used = new Set<string>();
  const claim = (raw: string, fileId: string): string => {
    const cleaned = raw.trim() || fileId;
    if (!used.has(cleaned)) {
      used.add(cleaned);
      return cleaned;
    }
    const dot = cleaned.lastIndexOf(".");
    const base = dot > 0 ? cleaned.slice(0, dot) : cleaned;
    const ext = dot > 0 ? cleaned.slice(dot) : "";
    const alt = `${base}-${fileId}${ext}`;
    used.add(alt);
    return alt;
  };

  const entries: ZipEntry[] = [];
  let totalBytes = 0;
  for (const { file, path } of located) {
    const v = versions.get(file.id);
    if (!v) continue;
    entries.push({
      entryName: claim(path, file.id),
      storageKey: v.storageKey,
      sizeBytes: v.fileSize ?? 0,
    });
    totalBytes += v.fileSize ?? 0;
  }

  if (entries.length === 0) {
    return { ok: false, status: 404, message: "This folder has no files to download." };
  }
  const tooLarge = overLimit("folder", entries.length, totalBytes);
  if (tooLarge) return tooLarge;

  return { ok: true, entries, totalBytes, zipName: rootName, skipped: 0 };
}

/**
 * Plan a vault zip: resolve, authorize and size-check it. The prepare and zip
 * routes both call this, so the check that shows the user an error and the
 * check that guards the bytes cannot drift apart.
 *
 * Takes a raw client and scopes every query by the `tenantId` it is handed.
 */
export function planVaultZip(
  db: SupabaseClient,
  tenantId: string,
  scope: FolderAccessScope,
  request: VaultZipRequest
): Promise<VaultZipPlan> {
  return request.kind === "files"
    ? planFiles(db, tenantId, request.fileIds, scope)
    : planFolder(db, tenantId, request.folderId, scope);
}

// ─── Misc ──────────────────────────────────────────────────────────────────

export function safeZipFilename(base: string): string {
  const safe = base.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_");
  return `${safe || "download"}.zip`;
}
