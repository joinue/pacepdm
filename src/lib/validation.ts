import { z, ZodError, ZodType } from "zod";
import { NextResponse } from "next/server";

/**
 * Server-side request validation built on zod.
 *
 * Use `parseBody` in API route handlers to validate the JSON request body
 * against a zod schema. On validation failure, the helper returns a
 * NextResponse with a 400 status and a structured error object — the
 * route doesn't need to write its own error handling for shape mismatches.
 *
 * Usage in a route:
 *   const Body = z.object({ name: z.string().min(1) });
 *
 *   export async function POST(req: NextRequest) {
 *     const parsed = await parseBody(req, Body);
 *     if (!parsed.ok) return parsed.response;
 *     const { name } = parsed.data;     // fully typed and validated
 *     ...
 *   }
 *
 * Why a result object instead of throws: the route handler stays linear
 * and explicit, and we never accidentally let a validation error escape
 * into the generic 500 catch.
 */

interface ParseSuccess<T> {
  ok: true;
  data: T;
}

interface ParseFailure {
  ok: false;
  response: NextResponse;
}

export type ParseResult<T> = ParseSuccess<T> | ParseFailure;

/**
 * Validate a JSON request body against a zod schema. Returns a discriminated
 * result so route handlers can branch cleanly:
 *
 *   const parsed = await parseBody(req, Schema);
 *   if (!parsed.ok) return parsed.response;
 *
 * Failure cases handled:
 *   - Body is missing or not valid JSON → 400 with "Invalid JSON body"
 *   - Body fails schema validation     → 400 with field-level error map
 */
export async function parseBody<T>(
  request: Request,
  schema: ZodType<T>
): Promise<ParseResult<T>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }),
    };
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "Validation failed",
          details: formatZodError(result.error),
        },
        { status: 400 }
      ),
    };
  }

  return { ok: true, data: result.data };
}

/**
 * Validate URL search params against a zod schema. Same shape as `parseBody`
 * but reads from `request.nextUrl.searchParams`.
 *
 * Coerces all values to strings (the URL representation) before parsing,
 * so use `z.coerce.number()` etc. in your schema for numeric query params.
 */
export function parseSearchParams<T>(
  request: { nextUrl: { searchParams: URLSearchParams } },
  schema: ZodType<T>
): ParseResult<T> {
  const params: Record<string, string> = {};
  request.nextUrl.searchParams.forEach((value, key) => {
    params[key] = value;
  });

  const result = schema.safeParse(params);
  if (!result.success) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "Invalid query parameters",
          details: formatZodError(result.error),
        },
        { status: 400 }
      ),
    };
  }

  return { ok: true, data: result.data };
}

/**
 * Convert a ZodError into a flat `{ field: message }` map suitable for
 * surfacing in API error responses. Nested fields are dot-joined.
 */
export function formatZodError(error: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join(".") : "_";
    if (!out[path]) out[path] = issue.message;
  }
  return out;
}

// ─── Common reusable schema fragments ─────────────────────────────────────
//
// Shared building blocks so individual routes don't have to re-declare
// "non-empty trimmed string" or "uuid" inline. Compose them in route schemas.

/** A non-empty trimmed string. Trims first, then enforces min length 1. */
export const nonEmptyString = z
  .string()
  .trim()
  .min(1, "Must not be empty");

/** Optional non-empty trimmed string — empty strings are coerced to null. */
export const optionalString = z
  .string()
  .trim()
  .transform((s) => (s === "" ? null : s))
  .nullable()
  .optional();

/** A UUID v4 string (Supabase IDs). */
export const uuid = z.string().uuid("Must be a valid UUID");

/** Optional UUID — accepts null and empty string as null. */
export const optionalUuid = z
  .union([uuid, z.literal(""), z.null()])
  .transform((v) => (v === "" || v == null ? null : v))
  .nullable()
  .optional();

/** Positive number with sensible default for quantities. */
export const positiveNumber = z.number().positive("Must be greater than zero");

/** Non-negative number for costs. */
export const nonNegativeNumber = z.number().min(0, "Must be zero or greater");

// Re-export z so consumers don't need a separate import.
export { z };
