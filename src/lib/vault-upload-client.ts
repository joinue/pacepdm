import { ApiError, fetchJson } from "@/lib/api-client";

/**
 * The browser half of uploading to the vault. See lib/vault-uploads.ts for
 * the server half and why the bytes no longer go through a route.
 *
 *   prepare (JSON) → PUT the file straight to storage → commit (JSON)
 */

export interface UploadTarget {
  uploadUrl: string;
  uploadToken: string;
}

export interface UploadProgress {
  loaded: number;
  total: number;
}

export interface DuplicateFileInfo {
  id: string;
  name: string;
  currentVersion: number;
  isCheckedOut: boolean;
  checkedOutById: string | null;
  isFrozen: boolean;
  lifecycleState: string;
}

interface UploadOptions {
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}

/**
 * Send a file to a signed storage upload URL, reporting progress.
 *
 * XHR rather than fetch, because fetch cannot report upload progress, and a
 * silent two-minute wait on a large assembly reads as a hang. The body is the
 * same multipart shape storage-js's `uploadToSignedUrl` sends.
 */
export function putToStorage(
  target: UploadTarget,
  file: File,
  { onProgress, signal }: UploadOptions = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Upload cancelled", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", target.uploadUrl);
    xhr.setRequestHeader("x-upsert", "false");
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (anonKey) xhr.setRequestHeader("apikey", anonKey);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.({ loaded: event.loaded, total: event.total });
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(storageUploadError(xhr.status, xhr.responseText, file));
    };
    xhr.onerror = () =>
      reject(new ApiError("The upload was interrupted. Check your connection and try again.", 0));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });

    const body = new FormData();
    body.append("cacheControl", "3600");
    body.append("", file);
    xhr.send(body);
  });
}

/**
 * Turn a refusal from storage into something a user can act on. Storage's own
 * messages ("The object exceeded the maximum allowed size") do not say which
 * limit or what to do about it.
 */
export function storageUploadError(status: number, responseText: string, file: File): ApiError {
  let message = "";
  try {
    const parsed = JSON.parse(responseText) as { message?: string; error?: string };
    message = parsed.message || parsed.error || "";
  } catch {
    message = responseText;
  }
  if (status === 413 || /maximum allowed size|too large/i.test(message)) {
    return new ApiError(
      `"${file.name}" (${formatBytes(file.size)}) is larger than the workspace's storage upload limit. An admin can raise it in the Supabase Storage settings.`,
      413
    );
  }
  return new ApiError(
    `Storage refused "${file.name}"${message ? `: ${message}` : ""} (status ${status})`,
    status
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** The existing file, when a prepare or commit was refused as a duplicate name. */
export function duplicateOf(err: unknown): DuplicateFileInfo | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const details = (err.details as { details?: { code?: string; existingFile?: DuplicateFileInfo } })
    ?.details;
  return details?.code === "DUPLICATE_FILE" && details.existingFile ? details.existingFile : null;
}

export interface NewFileFields {
  partNumber?: string;
  description?: string;
  category?: string;
  lifecycleState?: string;
}

/** Upload a new file into a folder. Throws an ApiError; see `duplicateOf`. */
export async function uploadNewFile<T = { id: string; name: string }>(
  folderId: string,
  file: File,
  fields: NewFileFields = {},
  options: UploadOptions = {}
): Promise<T> {
  const target = await fetchJson<UploadTarget>("/api/files/uploads", {
    method: "POST",
    body: { folderId, fileName: file.name, size: file.size },
    signal: options.signal,
  });
  await putToStorage(target, file, options);
  return fetchJson<T>("/api/files", {
    method: "POST",
    body: { uploadToken: target.uploadToken, ...fields },
    signal: options.signal,
  });
}

/**
 * Add a version to an existing file.
 *
 *   checkin — closes the caller's checkout with this version.
 *   version — "upload as new version", no checkout needed.
 */
export async function uploadNewVersion(
  fileId: string,
  file: File,
  purpose: "checkin" | "version",
  comment: string | null,
  options: UploadOptions = {}
): Promise<{ success: true; version: number }> {
  const base = `/api/files/${fileId}/${purpose === "checkin" ? "checkin" : "upload-version"}`;
  const target = await fetchJson<UploadTarget>(`${base}/upload`, {
    method: "POST",
    body: { fileName: file.name, size: file.size },
    signal: options.signal,
  });
  await putToStorage(target, file, options);
  return fetchJson(base, {
    method: "POST",
    body: { uploadToken: target.uploadToken, comment },
    signal: options.signal,
  });
}

interface FolderRow {
  id: string;
  name: string;
}

/**
 * Resolve a relative folder path under `rootFolderId`, creating the folders
 * that do not exist yet. Returns the id of the deepest one.
 *
 * `cache` is shared across one batch, keyed by path, and holds the promise
 * rather than the id, so ten files dropped from the same subfolder create it
 * once instead of racing to create it ten times.
 */
export function ensureFolderPath(
  rootFolderId: string,
  segments: string[],
  cache: Map<string, Promise<string>>
): Promise<string> {
  let parent: Promise<string> = Promise.resolve(rootFolderId);
  let path = "";
  for (const name of segments) {
    path = `${path}/${name}`;
    const cached = cache.get(path);
    if (cached) {
      parent = cached;
      continue;
    }
    const next = parent.then((parentId) => findOrCreateFolder(parentId, name));
    cache.set(path, next);
    parent = next;
  }
  return parent;
}

async function findOrCreateFolder(parentId: string, name: string): Promise<string> {
  try {
    const created = await fetchJson<FolderRow>("/api/folders", {
      method: "POST",
      body: { name, parentId },
    });
    return created.id;
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 409) throw err;
    const children = await fetchJson<FolderRow[]>(
      `/api/folders?parentId=${encodeURIComponent(parentId)}`
    );
    const existing = children.find((f) => f.name === name);
    if (!existing) throw err;
    return existing.id;
  }
}
