// Server-side streaming zip for vault selections and folder downloads.
//
// This is the bulk-download counterpart to buildReleaseZipStream in
// src/lib/releases.ts. The release flow already proved the pattern: stream
// each file from Supabase storage through fflate's Zip / ZipPassThrough so
// memory stays bounded regardless of how many or how large the files are.
// The previous client-side approach (zipSync + ArrayBuffer per file) OOMed
// the browser tab on selections of any real-world size.
//
// Two endpoints feed this module:
//   • bulk-download/prepare       — caller passes fileIds explicitly
//   • folders/[id]/download/prepare — caller passes a folderId; we expand
//                                     to every descendant file and preserve
//                                     the relative folder path as the zip
//                                     entry name.
//
// Both mint an HMAC-signed token (same pattern as share-tokens.ts) that the
// browser then GETs to start the actual download. Two-step flow because:
//   • POST → stream response can't be turned into a native browser download
//     UI without a service worker. GET to a signed URL works out of the box.
//   • Stuffing 200 file IDs into a query string blows past URL limits.

import { createHmac, timingSafeEqual } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Zip, ZipPassThrough } from "fflate";
import { filterViewable, type FolderAccessScope } from "./folder-access";

// ─── Limits ───────────────────────────────────────────────────────────────

// Hard ceiling for a single bulk-download archive. The stream itself is
// memory-bounded, but a 30-minute download from a misclick is still a bad
// experience — and Supabase egress isn't free.
export const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB

// Token TTL. Long enough that a slow click-to-download still works after
// the user reads any size warning, short enough that a leaked token is a
// blip rather than an ongoing exposure.
const TOKEN_TTL_SECONDS = 5 * 60;

// ─── Resolved file shape used by the stream builder ───────────────────────

export interface ZipEntry {
  /** Path of the entry inside the zip ("Drawings/widget.pdf"). */
  entryName: string;
  /** Supabase storage key for the latest version. */
  storageKey: string;
  /** Used only for the size guardrail; not enforced per-entry. */
  sizeBytes: number;
}

// ─── Token signing (stateless, HMAC) ──────────────────────────────────────
//
// The token is a base64url JSON payload with a sha256 HMAC suffix, keyed by
// SUPABASE_SERVICE_ROLE_KEY (same key share-tokens.ts uses). Stateless so
// we don't need a new DB table just for download intents.

interface TokenPayload {
  /** Tenant the request was authorized in. */
  t: string;
  /** User who prepared the download (for audit on the GET side). */
  u: string;
  /** Resolved entries: storage key + zip entry path. Authorization
   *  happened on the prepare endpoint; the GET trusts the signed list. */
  f: { k: string; n: string }[];
  /** Suggested filename for the download (no path, no extension forced). */
  z: string;
  /** Unix seconds expiry. */
  e: number;
}

function getSigningKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required to sign download tokens");
  return key;
}

function sign(payload: string): string {
  return createHmac("sha256", getSigningKey()).update(payload).digest("base64url");
}

export function signDownloadToken(input: {
  tenantId: string;
  userId: string;
  entries: ZipEntry[];
  zipName: string;
}): string {
  const payload: TokenPayload = {
    t: input.tenantId,
    u: input.userId,
    f: input.entries.map((e) => ({ k: e.storageKey, n: e.entryName })),
    z: input.zipName,
    e: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export interface VerifiedDownloadToken {
  tenantId: string;
  userId: string;
  entries: ZipEntry[];
  zipName: string;
}

export function verifyDownloadToken(token: string):
  | { ok: true; verified: VerifiedDownloadToken }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" } {
  const idx = token.lastIndexOf(".");
  if (idx <= 0) return { ok: false, reason: "malformed" };
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = Buffer.from(sign(body));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: "bad_signature" };
  }
  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (payload.e < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "expired" };
  }
  return {
    ok: true,
    verified: {
      tenantId: payload.t,
      userId: payload.u,
      entries: payload.f.map((f) => ({ entryName: f.n, storageKey: f.k, sizeBytes: 0 })),
      zipName: payload.z,
    },
  };
}

// ─── Resolution: fileIds → ZipEntry[] ─────────────────────────────────────

interface FileRow {
  id: string;
  name: string;
  folderId: string;
  currentVersion: number;
}

interface VersionRow {
  fileId: string;
  storageKey: string;
  fileSize: number;
}

/**
 * Resolve a set of file IDs into zip entries: applies tenant scoping,
 * filters by folder access, and looks up the storage key for each file's
 * current version. De-duplicates entry names by appending the file ID,
 * because zips with duplicate entry paths confuse some extractors.
 *
 * Caller is responsible for the size cap check — we return totalBytes so
 * the prepare route can decide.
 */
export async function resolveFilesToEntries(
  db: SupabaseClient,
  tenantId: string,
  fileIds: string[],
  scope: FolderAccessScope
): Promise<{ entries: ZipEntry[]; totalBytes: number; missing: number }> {
  if (fileIds.length === 0) return { entries: [], totalBytes: 0, missing: 0 };

  const { data: rawFiles } = await db
    .from("files")
    .select("id, name, folderId, currentVersion")
    .in("id", fileIds)
    .eq("tenantId", tenantId);

  const files = filterViewable(scope, (rawFiles as FileRow[] | null) ?? [], (f) => f.folderId);
  if (files.length === 0) return { entries: [], totalBytes: 0, missing: fileIds.length };

  // One round-trip for all current versions instead of N. We over-fetch
  // (every version per file) and pick the matching version in JS — cheaper
  // than N parallel single-row lookups for any non-trivial selection.
  const ids = files.map((f) => f.id);
  const { data: versions } = await db
    .from("file_versions")
    .select("fileId, version, storageKey, fileSize")
    .in("fileId", ids);

  const versionByKey = new Map<string, VersionRow>();
  for (const v of (versions as (VersionRow & { version: number })[] | null) ?? []) {
    versionByKey.set(`${v.fileId}:${v.version}`, v);
  }

  const used = new Set<string>();
  const claim = (fileId: string, raw: string): string => {
    const cleaned = raw.replace(/[\\]/g, "_").trim() || fileId;
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
    const v = versionByKey.get(`${f.id}:${f.currentVersion}`);
    if (!v) continue;
    entries.push({
      entryName: claim(f.id, f.name),
      storageKey: v.storageKey,
      sizeBytes: v.fileSize ?? 0,
    });
    totalBytes += v.fileSize ?? 0;
  }
  return { entries, totalBytes, missing: fileIds.length - entries.length };
}

/**
 * Resolve a folder ID into zip entries for every descendant file (and
 * the folder's own files). Preserves the folder hierarchy inside the zip
 * so an extracted archive looks like the user's project structure.
 *
 * Recursion uses the materialized `path` column on folders — single query
 * for "this folder and everything below it" instead of N walks.
 */
export async function resolveFolderToEntries(
  db: SupabaseClient,
  tenantId: string,
  folderId: string,
  scope: FolderAccessScope
): Promise<
  | { ok: true; entries: ZipEntry[]; totalBytes: number; rootName: string }
  | { ok: false; reason: "not_found" | "forbidden" }
> {
  const { data: root } = await db
    .from("folders")
    .select("id, name, path")
    .eq("id", folderId)
    .eq("tenantId", tenantId)
    .maybeSingle();

  if (!root) return { ok: false, reason: "not_found" };

  // Treat root + descendants as a single set. The `path` column is
  // slash-delimited from migration-001 (e.g. "/Projects/Widget-X").
  // Single PostgREST `.or()` would be tempting, but a comma inside a
  // folder name breaks the OR parser — so we over-fetch with a single
  // LIKE that may include siblings (e.g. `/Foo%` matches `/Foobar`)
  // and tighten the boundary in JS.
  const rootPath = root.path as string;
  const overPattern = rootPath === "/" ? "/%" : `${rootPath}%`;

  const { data: rawFolders } = await db
    .from("folders")
    .select("id, path")
    .eq("tenantId", tenantId)
    .like("path", overPattern);

  const folderRows = ((rawFolders as { id: string; path: string }[] | null) ?? []).filter(
    (f) => f.path === rootPath || f.path.startsWith(rootPath === "/" ? "/" : `${rootPath}/`)
  );

  const visibleFolders = filterViewable(scope, folderRows, (f) => f.id);

  // The user must at least be able to see the root they asked for. If
  // filterViewable dropped it, treat the whole request as forbidden.
  const folderById = new Map(visibleFolders.map((f) => [f.id, f]));
  if (!folderById.has(root.id)) return { ok: false, reason: "forbidden" };

  if (visibleFolders.length === 0) {
    return { ok: true, entries: [], totalBytes: 0, rootName: root.name };
  }

  const folderIds = visibleFolders.map((f) => f.id);
  const { data: rawFiles } = await db
    .from("files")
    .select("id, name, folderId, currentVersion")
    .in("folderId", folderIds)
    .eq("tenantId", tenantId);

  const files = (rawFiles as FileRow[] | null) ?? [];
  if (files.length === 0) {
    return { ok: true, entries: [], totalBytes: 0, rootName: root.name };
  }

  const ids = files.map((f) => f.id);
  const { data: versions } = await db
    .from("file_versions")
    .select("fileId, version, storageKey, fileSize")
    .in("fileId", ids);

  const versionByKey = new Map<string, VersionRow>();
  for (const v of (versions as (VersionRow & { version: number })[] | null) ?? []) {
    versionByKey.set(`${v.fileId}:${v.version}`, v);
  }

  // Compute each file's path inside the zip. The zip's top-level folder is
  // the root folder name; everything below uses the path tail relative to
  // the root. So /Projects/Widget-X/Drawings/foo.pdf becomes
  // Widget-X/Drawings/foo.pdf inside the archive.
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

  const safeName = (s: string) => s.replace(/[\\/]/g, "_");

  const entries: ZipEntry[] = [];
  let totalBytes = 0;
  for (const f of files) {
    const folder = folderById.get(f.folderId);
    if (!folder) continue;
    const v = versionByKey.get(`${f.id}:${f.currentVersion}`);
    if (!v) continue;

    const folderPath = folder.path as string;
    let relative: string;
    if (folder.id === root.id) {
      relative = "";
    } else {
      // path = rootPath + "/" + tail  →  tail
      const prefix = rootPath === "/" ? "/" : `${rootPath}/`;
      relative = folderPath.startsWith(prefix) ? folderPath.slice(prefix.length) : folderPath;
    }
    const segments = relative.split("/").filter(Boolean).map(safeName);
    const inZipPath = [safeName(root.name), ...segments, safeName(f.name)].join("/");
    entries.push({
      entryName: claim(inZipPath, f.id),
      storageKey: v.storageKey,
      sizeBytes: v.fileSize ?? 0,
    });
    totalBytes += v.fileSize ?? 0;
  }

  return { ok: true, entries, totalBytes, rootName: root.name };
}

// ─── Zip stream ────────────────────────────────────────────────────────────

/**
 * Build a ReadableStream of zip output for the given entries. Mirrors
 * buildReleaseZipStream — fetches each file from Supabase storage via a
 * short-lived signed URL and forwards body chunks straight into the zip
 * entry's push() method. Memory stays at one chunk + zip framing.
 */
export function buildFilesZipStream(
  entries: ZipEntry[],
  db: SupabaseClient
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const zip = new Zip((err, data, final) => {
        if (err) {
          controller.error(err);
          return;
        }
        if (data && data.length > 0) controller.enqueue(data);
        if (final) controller.close();
      });

      try {
        for (const entry of entries) {
          const { data: signed, error: signErr } = await db.storage
            .from("vault")
            .createSignedUrl(entry.storageKey, 300);
          if (signErr || !signed) continue;

          const response = await fetch(signed.signedUrl);
          if (!response.ok || !response.body) continue;

          const ze = new ZipPassThrough(entry.entryName);
          zip.add(ze);

          const reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              ze.push(new Uint8Array(0), true);
              break;
            }
            if (value && value.length > 0) ze.push(value, false);
          }
        }
        zip.end();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

// ─── Misc ──────────────────────────────────────────────────────────────────

export function safeZipFilename(base: string): string {
  const safe = base.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_");
  return `${safe || "download"}.zip`;
}
