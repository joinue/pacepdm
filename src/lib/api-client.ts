/**
 * Centralized fetch wrapper with proper error handling.
 *
 * Solves the codebase-wide problem of `.catch(() => {})`, generic
 * "Failed to X" toasts that hide real errors, and unguarded `await res.json()`
 * calls that crash on non-JSON responses.
 *
 * Use this for all client-side API calls instead of raw `fetch()`.
 */

export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

interface FetchJsonOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Fetch JSON with consistent error handling.
 *
 * - Sets Content-Type automatically when body is provided
 * - Parses JSON safely (won't throw on non-JSON error pages)
 * - Throws ApiError with server-provided message on non-2xx
 * - Returns parsed JSON on success
 *
 * Pass an AbortSignal to support cancellation.
 */
export async function fetchJson<T = unknown>(
  url: string,
  options: FetchJsonOptions = {}
): Promise<T> {
  const { body, headers, ...rest } = options;

  const init: RequestInit = {
    ...rest,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
  };

  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    // Network failure or aborted
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError("Network error — check your connection", 0, err);
  }

  // Try to parse body as JSON regardless of status — many error responses include {error: "..."}
  let data: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // Non-JSON response (HTML error page, plain text, etc.)
      data = text;
    }
  }

  if (!response.ok) {
    const message =
      (data &&
      typeof data === "object" &&
      "error" in data &&
      typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : null) ||
      (typeof data === "string" && data) ||
      response.statusText ||
      `Request failed with status ${response.status}`;
    throw new ApiError(message, response.status, data);
  }

  return data as T;
}

/**
 * Upload a file to a route that reads `multipart/form-data`.
 *
 * `fetchJson` cannot serve these: it JSON-encodes the body and sets a
 * Content-Type, and a FormData body must be handed to fetch untouched so the
 * browser can generate the multipart boundary. Error handling is identical —
 * the server's message reaches the caller as an `ApiError`.
 *
 *   await uploadFile(`/api/boms/${bomId}/thumbnail`, file);
 */
export async function uploadFile<T = unknown>(
  url: string,
  file: File,
  options: { field?: string; method?: string; extra?: Record<string, string> } = {}
): Promise<T> {
  const { field = "file", method = "POST", extra } = options;
  const form = new FormData();
  form.append(field, file);
  for (const [key, value] of Object.entries(extra ?? {})) form.append(key, value);

  let response: Response;
  try {
    response = await fetch(url, { method, body: form });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError("Network error — check your connection", 0, err);
  }

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message =
      (data &&
      typeof data === "object" &&
      "error" in data &&
      typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : null) ||
      (typeof data === "string" && data) ||
      response.statusText ||
      `Upload failed with status ${response.status}`;
    throw new ApiError(message, response.status, data);
  }

  return data as T;
}

/**
 * Convenience: extract user-facing error message from any thrown error.
 * Use in catch blocks to feed toast.error().
 */
export function errorMessage(err: unknown): string {
  if (err instanceof DOMException && err.name === "AbortError") return "";
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong";
}

/**
 * Returns true if the error was an aborted request (should be ignored silently).
 */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}
