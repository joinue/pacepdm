/**
 * Entity thumbnails — the one place the storage layout, the upload rules, and
 * the signing expiry are decided.
 *
 * Four entities carry a picture: files, parts, BOMs, and vendors. Each row
 * stores a `thumbnailKey` — an object path inside the "vault" bucket — and the
 * API signs a short-lived URL on read, which the client reads as
 * `thumbnailUrl`. Rows never hold image bytes or data URLs (see
 * migration 024 for why that was undone).
 *
 * Object layout:
 *
 *   {tenantId}/thumbnails/{entity}/{entityId}-{timestamp}.{ext}
 *
 * The tenant prefix is the only isolation storage has — Supabase Storage is not
 * tenant-aware and `ScopedDb.storage` hands back the raw client. Always build
 * keys with `thumbnailKeyFor` rather than assembling a path by hand.
 *
 * Writes happen from server routes via the service role, which bypasses storage
 * RLS; reads reach the browser as signed URLs. That is why no storage policy
 * exists for these objects.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { badRequest, unprocessable, ApiFailure } from "@/lib/api-route";

/** The bucket every thumbnail lives in — shared with the files module. */
export const THUMBNAIL_BUCKET = "vault";

/** Thumbnails are previews, not originals. 5 MB is already generous. */
export const THUMBNAIL_MAX_BYTES = 5 * 1024 * 1024;

/** How long a signed thumbnail URL stays valid. Matches the files module. */
export const THUMBNAIL_URL_TTL_SECONDS = 300;

const ALLOWED_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Entities that can carry a thumbnail. The value is the storage folder. */
export type ThumbnailEntity = "parts" | "boms" | "vendors";

/** Supabase's storage client, as reached through `db.storage` or a raw client. */
type Storage = SupabaseClient["storage"];

export function thumbnailKeyFor(
  tenantId: string,
  entity: ThumbnailEntity,
  entityId: string,
  mimeType: string
): string {
  const ext = ALLOWED_MIME[mimeType] ?? "bin";
  return `${tenantId}/thumbnails/${entity}/${entityId}-${Date.now()}.${ext}`;
}

/**
 * Pull the image out of a multipart request and validate it.
 *
 * Throws `ApiFailure`, so a route handler can call this at the top and let the
 * wrapper map the status — 400 for a missing file, 422 for one we refuse.
 */
export async function readThumbnailUpload(request: Request): Promise<File> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw badRequest("Expected a multipart form with a `file` field");
  }

  const file = form.get("file");
  if (!(file instanceof File)) throw badRequest("Missing file");
  if (file.size === 0) throw badRequest("File is empty");
  if (file.size > THUMBNAIL_MAX_BYTES) {
    throw unprocessable(
      `Image is too large (max ${Math.round(THUMBNAIL_MAX_BYTES / 1024 / 1024)} MB)`
    );
  }
  if (!(file.type in ALLOWED_MIME)) {
    throw unprocessable(`Unsupported image type — use ${Object.keys(ALLOWED_MIME).join(", ")}`);
  }
  return file;
}

/**
 * Upload `file` as the thumbnail for one entity and return its storage key.
 *
 * The caller is responsible for writing the key onto the row. `previousKey` is
 * removed afterwards on a best-effort basis: a stale object costs storage, but
 * failing the request over it would lose the upload that just succeeded.
 */
export async function storeThumbnail(options: {
  storage: Storage;
  tenantId: string;
  entity: ThumbnailEntity;
  entityId: string;
  file: File;
  previousKey?: string | null;
}): Promise<string> {
  const { storage, tenantId, entity, entityId, file, previousKey } = options;
  const key = thumbnailKeyFor(tenantId, entity, entityId, file.type);

  const { error } = await storage
    .from(THUMBNAIL_BUCKET)
    .upload(key, file, { contentType: file.type, upsert: false });
  if (error) throw new Error(`Thumbnail upload failed: ${error.message}`);

  await removeThumbnail(storage, previousKey);
  return key;
}

/**
 * Delete a thumbnail object. Never throws: the row is the source of truth for
 * whether an entity has a picture, and an orphaned object is not a failure the
 * user can act on.
 */
export async function removeThumbnail(storage: Storage, key: string | null | undefined) {
  if (!key) return;
  try {
    const { error } = await storage.from(THUMBNAIL_BUCKET).remove([key]);
    if (error) console.warn(`[thumbnails] could not remove ${key}: ${error.message}`);
  } catch (err) {
    console.warn(`[thumbnails] could not remove ${key}:`, err);
  }
}

/** Sign one key. Returns null for a missing key or a failed signature. */
export async function signThumbnailUrl(
  storage: Storage,
  key: string | null | undefined
): Promise<string | null> {
  if (!key) return null;
  const { data } = await storage
    .from(THUMBNAIL_BUCKET)
    .createSignedUrl(key, THUMBNAIL_URL_TTL_SECONDS);
  return data?.signedUrl ?? null;
}

/**
 * Sign many keys at once, de-duplicated. Lists sign one URL per distinct key
 * rather than one per row — a BOM whose lines all reference the same part
 * would otherwise issue the same signature a dozen times.
 */
export async function signThumbnailUrls(
  storage: Storage,
  keys: (string | null | undefined)[]
): Promise<Map<string, string>> {
  const distinct = Array.from(new Set(keys.filter((k): k is string => !!k)));
  const urlByKey = new Map<string, string>();
  await Promise.all(
    distinct.map(async (key) => {
      const url = await signThumbnailUrl(storage, key);
      if (url) urlByKey.set(key, url);
    })
  );
  return urlByKey;
}

/**
 * Replace `thumbnailKey` with a signed `thumbnailUrl` on a row read from the
 * database. The key is dropped from the result: it is a storage detail the
 * client has no use for, and leaking it invites someone to build a URL by hand.
 */
export function withThumbnailUrl<T extends { thumbnailKey?: string | null }>(
  row: T,
  urlByKey: Map<string, string>
): Omit<T, "thumbnailKey"> & { thumbnailUrl: string | null } {
  const { thumbnailKey, ...rest } = row;
  return {
    ...(rest as Omit<T, "thumbnailKey">),
    thumbnailUrl: thumbnailKey ? (urlByKey.get(thumbnailKey) ?? null) : null,
  };
}
