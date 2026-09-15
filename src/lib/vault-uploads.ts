/**
 * Uploading file content straight to storage.
 *
 * Every upload, check-in and new version used to travel as multipart form data
 * through a route handler, which read the whole file into function memory
 * (about three copies of it) before passing it on to storage. That put the
 * app's real ceiling at Vercel's 100 MB request limit or the storage upload
 * limit, whichever was lower, and a failure surfaced as "Failed to upload
 * file" — so an engineer holding a checkout of a large assembly could not
 * check it back in (AUD-003 VLT-1).
 *
 * Now each is three steps, and the bytes never touch a function:
 *
 *   1. prepare — a route checks everything it can before any bytes move
 *      (permission, folder access, name, size, duplicates, checkout state),
 *      then returns a signed storage upload URL and an upload grant.
 *   2. upload  — the browser PUTs the file to that URL, with progress.
 *   3. commit  — the route that records the file or version is given the
 *      grant, re-checks what may have changed while the upload ran, confirms
 *      the object arrived at the expected size, and writes the rows.
 *
 * The grant is an HMAC-signed statement of what was authorised: which tenant,
 * which user, which file id, which storage key, which name and size, and for
 * what purpose. The commit trusts nothing else from the client about the
 * content, so a grant cannot be replayed for another file, user or tenant.
 *
 * Storage keys are built from ids (`<tenant>/files/<fileId>/<uuid>`). Keys
 * built from the uploaded name were refused by storage for names containing
 * characters like Ø ° µ – [ ] (AUD-003 VLT-4), and `#` or `?` silently
 * truncated the key.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { badRequest, conflict, forbidden } from "@/lib/api-route";
import { hasPermission } from "@/lib/permissions";
import { getServiceClient } from "@/lib/db";
import { runAfterResponse } from "@/lib/notifications";
import { pendingApprovalRefusal } from "@/lib/pending-approval";
import { extractThumbnail } from "@/lib/thumbnail";

export const VAULT_BUCKET = "vault";

/**
 * The app's own ceiling. Storage enforces its own upload limit too (the
 * project-wide setting, 50 MB unless raised), and that is usually the one a
 * user meets first; the client explains it when it happens.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * Thumbnails are extracted after the response, which still means downloading
 * the file into a function. Above this size the attempt is recorded and
 * skipped; the detail panel's manual thumbnail upload still works.
 */
export const THUMBNAIL_SOURCE_MAX_BYTES = 200 * 1024 * 1024;

/**
 * File types the extractor can make a thumbnail from. Anything else is not
 * worth downloading to find out.
 */
export const THUMBNAIL_SOURCE_EXTENSIONS = new Set([
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "sldprt",
  "sldasm",
  "slddrw",
]);

/** Storage signed upload URLs are valid for two hours; the grant matches. */
const GRANT_TTL_MS = 2 * 60 * 60 * 1000;

export type UploadPurpose = "new" | "checkin" | "version";

export interface UploadGrant {
  v: 1;
  purpose: UploadPurpose;
  tenantId: string;
  userId: string;
  fileId: string;
  /** Destination folder for a new file; null for a version of an existing one. */
  folderId: string | null;
  key: string;
  name: string;
  size: number;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

// ─── Names and keys ─────────────────────────────────────────────────────────

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Why a file name cannot be used, or null if it can.
 *
 * Names are display values now — the storage key no longer contains them — so
 * this only refuses what would break a path, a zip entry or a download: path
 * separators, dot segments and control characters.
 */
export function fileNameProblem(name: string): string | null {
  if (!name.trim()) return "The file needs a name";
  if (name.length > 255) return "File names can be at most 255 characters";
  if (name.trim() === "." || name.trim() === "..") return "That is not a usable file name";
  if (/[/\\]/.test(name)) return "File names cannot contain / or \\";
  if (/[\x00-\x1f\x7f]/.test(name)) return "File names cannot contain control characters";
  return null;
}

/** A fresh storage key for one version of a file. Never derived from its name. */
export function vaultObjectKey(tenantId: string, fileId: string): string {
  return `${tenantId}/files/${fileId}/${randomUUID()}`;
}

export function fileThumbnailKey(tenantId: string, fileId: string, ext: string): string {
  return `${tenantId}/thumbnails/files/${fileId}-${randomUUID()}.${ext}`;
}

// ─── Grants ─────────────────────────────────────────────────────────────────

function grantKey(): Buffer {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret)
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set; uploads cannot be authorised");
  // A key derived for this one purpose, so an upload grant can never be
  // mistaken for any other token signed from the same secret.
  return createHmac("sha256", secret).update("pace-pdm/vault-upload-grant/v1").digest();
}

function sign(payload: string): string {
  return createHmac("sha256", grantKey()).update(payload).digest("base64url");
}

export function signUploadGrant(
  grant: Omit<UploadGrant, "v" | "exp">,
  now: number = Date.now()
): string {
  const payload = Buffer.from(
    JSON.stringify({ ...grant, v: 1, exp: now + GRANT_TTL_MS } satisfies UploadGrant)
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/**
 * Verify a grant's signature and expiry, and that it was issued to this caller
 * for this purpose (and file, when the route is about one). Throws the failure
 * the route should return.
 */
export function readUploadGrant(
  token: string,
  expect: { tenantId: string; userId: string; purpose: UploadPurpose; fileId?: string },
  now: number = Date.now()
): UploadGrant {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) throw badRequest("Invalid upload token");

  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw badRequest("Invalid upload token");
  }

  let grant: UploadGrant;
  try {
    grant = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as UploadGrant;
  } catch {
    throw badRequest("Invalid upload token");
  }

  if (grant.v !== 1) throw badRequest("Invalid upload token");
  if (grant.exp < now) throw badRequest("This upload expired. Upload the file again.");
  if (
    grant.tenantId !== expect.tenantId ||
    grant.userId !== expect.userId ||
    grant.purpose !== expect.purpose ||
    (expect.fileId !== undefined && grant.fileId !== expect.fileId)
  ) {
    throw forbidden("This upload was authorised for something else");
  }
  return grant;
}

// ─── Versions ───────────────────────────────────────────────────────────────

export interface VersionTarget {
  id: string;
  tenantId: string;
  isFrozen: boolean;
  isCheckedOut: boolean;
  checkedOutById: string | null;
}

/**
 * Whether this caller may add a version to this file right now, for this
 * purpose. Throws the refusal.
 *
 * Runs at prepare, so a user learns before uploading 200 MB that the file is
 * frozen, and again at commit, because any of it can change while the upload
 * runs.
 *
 *   checkin — closes the caller's own checkout (or, with admin.settings,
 *             someone else's) with a new version.
 *   version — "upload as new version" from the duplicate-name prompt, which
 *             needs no checkout but must not replace one someone else holds.
 */
export async function assertCanAddVersion(
  file: VersionTarget,
  user: { id: string; permissions: string[] },
  purpose: Exclude<UploadPurpose, "new">
): Promise<void> {
  if (purpose === "checkin") {
    if (!file.isCheckedOut) throw conflict("File is not checked out");
    if (file.checkedOutById !== user.id && !hasPermission(user.permissions, "admin.settings")) {
      throw forbidden("File is checked out by another user");
    }
    if (file.isFrozen) {
      throw conflict(
        "Cannot check in a frozen/released file. The release happened during your checkout — undo your checkout instead."
      );
    }
  } else {
    if (file.isFrozen) {
      throw conflict("Cannot create a new version of a released/frozen file. Revise it first.");
    }
    if (file.isCheckedOut && file.checkedOutById !== user.id) {
      throw conflict("File is checked out by another user");
    }
  }

  // A version added mid-review is what the approval would release, unreviewed.
  // See lib/pending-approval.ts.
  const refusal = await pendingApprovalRefusal(file.tenantId, file.id, "given a new version");
  if (refusal) {
    throw conflict(
      purpose === "checkin"
        ? `${refusal} Undo your checkout, or recall the request first.`
        : refusal
    );
  }
}

// ─── Storage ────────────────────────────────────────────────────────────────

type Storage = SupabaseClient["storage"];

export interface UploadTarget {
  /** Where the browser PUTs the file. */
  uploadUrl: string;
  /** The grant to hand back to the commit route. */
  uploadToken: string;
}

export async function createUploadTarget(
  storage: Storage,
  grant: Omit<UploadGrant, "v" | "exp">
): Promise<UploadTarget> {
  const { data, error } = await storage.from(VAULT_BUCKET).createSignedUploadUrl(grant.key);
  if (error || !data) {
    throw new Error(`Could not prepare the upload: ${error?.message ?? "no URL returned"}`);
  }
  return { uploadUrl: data.signedUrl, uploadToken: signUploadGrant(grant) };
}

/**
 * Confirm the object the grant names is in storage at the size that was
 * authorised. A commit without this would record a version pointing at nothing
 * — the upload may have failed, been abandoned, or been a different file.
 */
export async function confirmUploadedObject(storage: Storage, grant: UploadGrant): Promise<void> {
  const { data, error } = await storage.from(VAULT_BUCKET).info(grant.key);
  if (error || !data) {
    throw conflict("The file has not finished uploading. Upload it again.");
  }
  if (typeof data.size === "number" && data.size !== grant.size) {
    throw conflict(
      `The uploaded file is ${data.size} bytes, not the ${grant.size} that were authorised. Upload it again.`
    );
  }
}

/**
 * Remove an uploaded object that will not be recorded. Best effort: an object
 * nothing points at is garbage, not damage, so a failure is logged and the
 * request's own error still reaches the user.
 */
export async function discardUploadedObject(storage: Storage, key: string): Promise<void> {
  const { error } = await storage.from(VAULT_BUCKET).remove([key]);
  if (error) console.warn(`[uploads] could not remove unrecorded object ${key}:`, error.message);
}

// ─── Thumbnails ─────────────────────────────────────────────────────────────

export interface ThumbnailJob {
  tenantId: string;
  fileId: string;
  /** The version the thumbnail is for. A newer version wins if one lands first. */
  version: number;
  key: string;
  fileName: string;
  size: number;
}

/**
 * Extract a thumbnail after the response has been sent.
 *
 * Extraction used to run inside upload and check-in, holding the whole file in
 * memory and the user waiting while it ran — and the scan for SolidWorks
 * previews took 31 seconds on a 50 MB file.
 */
export function scheduleThumbnail(job: ThumbnailJob): void {
  runAfterResponse(
    () => generateFileThumbnail(getServiceClient(), job),
    `thumbnail for file ${job.fileId} version ${job.version}`
  );
}

/**
 * Extract, store and link a thumbnail for one version of a file.
 *
 * Every outcome stamps `thumbnailAttemptedAt`, which is what stops the folder
 * listing from queueing the same file again. Updates are conditional on the
 * file still being at `job.version`, so a slow extraction for an old version
 * can never replace the thumbnail of a newer one.
 */
export async function generateFileThumbnail(db: SupabaseClient, job: ThumbnailJob): Promise<void> {
  const attemptedAt = new Date().toISOString();

  const stamp = async (thumbnailKey?: string) => {
    const { error } = await db
      .from("files")
      .update(
        thumbnailKey
          ? { thumbnailKey, thumbnailAttemptedAt: attemptedAt }
          : { thumbnailAttemptedAt: attemptedAt }
      )
      .eq("id", job.fileId)
      .eq("tenantId", job.tenantId)
      .eq("currentVersion", job.version);
    if (error) {
      console.warn(`[thumbnail] could not record the attempt on ${job.fileId}:`, error.message);
    }
  };

  if (!THUMBNAIL_SOURCE_EXTENSIONS.has(extensionOf(job.fileName))) return;
  if (job.size > THUMBNAIL_SOURCE_MAX_BYTES) {
    await stamp();
    return;
  }

  try {
    const { data: blob, error: downloadError } = await db.storage
      .from(VAULT_BUCKET)
      .download(job.key);
    if (downloadError || !blob) {
      console.warn(`[thumbnail] could not read ${job.key}:`, downloadError?.message);
      await stamp();
      return;
    }

    const thumb = await extractThumbnail(await blob.arrayBuffer(), job.fileName);
    if (!thumb) {
      await stamp();
      return;
    }

    const thumbnailKey = fileThumbnailKey(job.tenantId, job.fileId, thumb.ext);
    const { error: uploadError } = await db.storage
      .from(VAULT_BUCKET)
      .upload(thumbnailKey, thumb.data, { contentType: thumb.mimeType, upsert: false });
    if (uploadError) {
      console.warn(
        `[thumbnail] could not store the thumbnail for ${job.fileId}:`,
        uploadError.message
      );
      await stamp();
      return;
    }
    await stamp(thumbnailKey);
  } catch (err) {
    console.warn(`[thumbnail] extraction failed for ${job.fileId}:`, err);
    await stamp();
  }
}
