/**
 * The API route contract.
 *
 * Every route handler under src/app/api/ is built with one of the wrappers in
 * this file. The wrapper owns the parts of a request that were previously
 * re-implemented in each of ~98 route files: session resolution, the permission
 * check, body and query validation, tenant scoping, and error mapping.
 *
 *   export const POST = withTenant(
 *     { permission: PERMISSIONS.FILE_EDIT, body: CreateBomSchema },
 *     async ({ db, tenantUser, body }) => {
 *       const { data, error } = await db.from("boms").insert({ ... }).select().single();
 *       if (error) throw new Error(error.message);
 *       return data;                       // → 200 application/json
 *     }
 *   );
 *
 * What the handler no longer has to do:
 *
 *   - `getApiTenantUser()` and the 401            → done, `tenantUser` is non-null
 *   - `hasPermission(...)` and the 403            → declare `permission`
 *   - `parseBody(...)` and the 400                → declare `body`
 *   - `.eq("tenantId", ...)` on every query       → `db` is already scoped
 *   - the trailing try/catch and message plumbing → throw, and it is mapped
 *
 * See docs/decisions/api-route-contract.md for why, and what was rejected.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import type { ZodType } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getApiTenantUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getServiceClient } from "@/lib/db";
import { createScopedDb, type ScopedDb } from "@/lib/tenant-db";
import { formatZodError } from "@/lib/validation";

// ─── Expected failures ──────────────────────────────────────────────────────

/**
 * An expected failure with a status code. Throw these from a handler instead of
 * returning a NextResponse: the handler body stays linear, and the response
 * shape is decided in one place.
 *
 * Anything that is NOT an ApiFailure is treated as a bug: logged with route
 * context and returned as a 500.
 */
export class ApiFailure extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiFailure";
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiFailure(message, 400, details);
export const unauthorized = (message = "Unauthorized") => new ApiFailure(message, 401);
export const forbidden = (message = "Forbidden") => new ApiFailure(message, 403);
export const notFound = (message = "Not found") => new ApiFailure(message, 404);
export const conflict = (message: string, details?: unknown) =>
  new ApiFailure(message, 409, details);
export const unprocessable = (message: string, details?: unknown) =>
  new ApiFailure(message, 422, details);

// ─── Shapes ─────────────────────────────────────────────────────────────────

/**
 * The tenant user as route handlers use it. `getApiTenantUser` returns an
 * untyped Supabase row (the client has no generated types); this is the shape
 * routes actually rely on.
 */
export interface TenantUser {
  id: string;
  tenantId: string;
  authUserId: string;
  email: string | null;
  fullName: string | null;
  roleId: string;
  role: { id: string; name: string; permissions: unknown };
  tenant?: { id: string; name: string } & Record<string, unknown>;
  [key: string]: unknown;
}

type RouteParams = Record<string, string>;

/** Next 16 hands route handlers their dynamic segments as a promise. */
interface NextRouteContext {
  params: Promise<RouteParams>;
}

type Inferred<S> = S extends ZodType<infer T> ? T : undefined;

/**
 * Dynamic segments. A route that declares a `params` schema gets the parsed
 * type; one that does not gets the raw string map.
 */
type ParamsOf<S> = S extends ZodType<infer T> ? T : RouteParams;

interface RouteOptions<TBody, TQuery, TParams> {
  /**
   * Permission(s) the caller must hold. A string requires one; an array
   * requires all of them. Omit for a route any authenticated tenant user may
   * call (most GETs).
   */
  permission?: string | string[];
  /** Zod schema for the JSON body. Presence of this implies the route reads one. */
  body?: TBody;
  /** Zod schema for the query string. Values arrive as strings — use z.coerce. */
  query?: TQuery;
  /**
   * Zod schema for the dynamic route segments. Optional, and worth declaring
   * for two reasons: the handler gets typed params instead of a string map,
   * and a malformed id is rejected at the boundary as a 400 rather than
   * reaching the database as a cast error.
   *
   *   params: z.object({ bomId: uuid })
   */
  params?: TParams;
  /**
   * Label used in server-side error logs. Defaults to the request method and
   * path, which is usually enough.
   */
  name?: string;
}

interface TenantContext<TBody, TQuery, TParams> {
  /** The raw request. Use for headers; body and query are already parsed. */
  request: NextRequest;
  /** Resolved dynamic segments. `{}` for static routes. */
  params: ParamsOf<TParams>;
  /** The authenticated caller. Never null inside a handler. */
  tenantUser: TenantUser;
  /** The caller's permission list, already normalised to string[]. */
  permissions: string[];
  /** Tenant-scoped database client. See lib/tenant-db.ts. */
  db: ScopedDb;
  /** Validated body, or undefined when no `body` schema was declared. */
  body: Inferred<TBody>;
  /** Validated query, or undefined when no `query` schema was declared. */
  query: Inferred<TQuery>;
}

/**
 * A handler may return a Response (when it needs control over headers,
 * streaming, or a redirect), any JSON-serialisable value (sent as 200 JSON), or
 * nothing (sent as 204).
 */
type HandlerResult = Response | unknown;

// ─── Shared plumbing ────────────────────────────────────────────────────────

function toPermissionList(role: { permissions: unknown } | undefined): string[] {
  const raw = role?.permissions;
  return Array.isArray(raw) ? (raw as string[]) : [];
}

async function parseWithSchema<T>(
  schema: ZodType<T>,
  value: unknown,
  errorLabel: string
): Promise<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest(errorLabel, formatZodError(result.error));
  }
  return result.data;
}

async function readJsonBody(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }
}

function searchParamsToObject(request: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  request.nextUrl.searchParams.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function toResponse(result: HandlerResult): Response {
  if (result instanceof Response) return result;
  if (result === undefined || result === null) return new NextResponse(null, { status: 204 });
  return NextResponse.json(result);
}

function handleError(err: unknown, label: string): Response {
  if (err instanceof ApiFailure) {
    const payload: Record<string, unknown> = { error: err.message };
    if (err.details !== undefined) payload.details = err.details;
    return NextResponse.json(payload, { status: err.status });
  }

  // Anything else is a bug. Log it with route context so a 500 is debuggable
  // from the server logs, and still surface the real message — a generic
  // "Something went wrong" makes production failures unresolvable.
  console.error(`[${label}] unhandled error:`, err);
  const message = err instanceof Error ? err.message : "Internal server error";
  return NextResponse.json({ error: message }, { status: 500 });
}

function labelFor(request: NextRequest, name?: string): string {
  if (name) return name;
  return `${request.method} ${request.nextUrl?.pathname ?? "?"}`;
}

// ─── withTenant ─────────────────────────────────────────────────────────────

/**
 * The default wrapper. Use it for every route that operates on tenant data.
 */
export function withTenant<
  TBody extends ZodType | undefined = undefined,
  TQuery extends ZodType | undefined = undefined,
  TParams extends ZodType | undefined = undefined,
>(
  options: RouteOptions<TBody, TQuery, TParams>,
  handler: (ctx: TenantContext<TBody, TQuery, TParams>) => Promise<HandlerResult>
) {
  return async function route(request: NextRequest, context?: NextRouteContext): Promise<Response> {
    const label = labelFor(request, options.name);

    try {
      const tenantUser = (await getApiTenantUser()) as TenantUser | null;
      if (!tenantUser) throw unauthorized();

      const permissions = toPermissionList(tenantUser.role);
      const required = options.permission;
      if (required) {
        const list = Array.isArray(required) ? required : [required];
        const missing = list.filter((p) => !hasPermission(permissions, p));
        if (missing.length > 0) {
          throw forbidden(`Forbidden: requires ${missing.join(", ")}`);
        }
      }

      const rawParams = (await context?.params) ?? {};
      const params = options.params
        ? await parseWithSchema(options.params as ZodType, rawParams, "Invalid route parameters")
        : rawParams;

      const body = options.body
        ? await parseWithSchema(
            options.body as ZodType,
            await readJsonBody(request),
            "Validation failed"
          )
        : undefined;

      const query = options.query
        ? await parseWithSchema(
            options.query as ZodType,
            searchParamsToObject(request),
            "Invalid query parameters"
          )
        : undefined;

      const result = await handler({
        request,
        params: params as ParamsOf<TParams>,
        tenantUser,
        permissions,
        db: createScopedDb(tenantUser.tenantId),
        body: body as Inferred<TBody>,
        query: query as Inferred<TQuery>,
      });

      return toResponse(result);
    } catch (err) {
      return handleError(err, label);
    }
  };
}

// ─── withPublicRoute ────────────────────────────────────────────────────────

interface PublicContext<TBody, TQuery, TParams> {
  request: NextRequest;
  params: ParamsOf<TParams>;
  body: Inferred<TBody>;
  query: Inferred<TQuery>;
  /**
   * The raw service-role client. There is no tenant to scope to — that is the
   * point of a public route — so every query here is the handler's own
   * responsibility.
   */
  db: SupabaseClient;
}

/**
 * For routes that must run before a tenant exists. This is a short and
 * deliberate list; adding to it is a review-worthy change:
 *
 *   - authentication (login, signup, password reset, SSO domain resolve)
 *   - onboarding, up to the point a tenant_users row exists
 *   - the public share viewer, authorised by a share token rather than a session
 *   - health checks
 *
 * The handler gets validation and error mapping, but no session, no permission
 * check, and no tenant scoping. Whatever authorises the request — a share
 * token, a signup code — the handler must check explicitly and first.
 */
export function withPublicRoute<
  TBody extends ZodType | undefined = undefined,
  TQuery extends ZodType | undefined = undefined,
  TParams extends ZodType | undefined = undefined,
>(
  options: Omit<RouteOptions<TBody, TQuery, TParams>, "permission">,
  handler: (ctx: PublicContext<TBody, TQuery, TParams>) => Promise<HandlerResult>
) {
  return async function route(request: NextRequest, context?: NextRouteContext): Promise<Response> {
    const label = labelFor(request, options.name);

    try {
      const rawParams = (await context?.params) ?? {};
      const params = options.params
        ? await parseWithSchema(options.params as ZodType, rawParams, "Invalid route parameters")
        : rawParams;

      const body = options.body
        ? await parseWithSchema(
            options.body as ZodType,
            await readJsonBody(request),
            "Validation failed"
          )
        : undefined;

      const query = options.query
        ? await parseWithSchema(
            options.query as ZodType,
            searchParamsToObject(request),
            "Invalid query parameters"
          )
        : undefined;

      const result = await handler({
        request,
        params: params as ParamsOf<TParams>,
        body: body as Inferred<TBody>,
        query: query as Inferred<TQuery>,
        db: getServiceClient(),
      });

      return toResponse(result);
    } catch (err) {
      return handleError(err, label);
    }
  };
}

// ─── withCron ───────────────────────────────────────────────────────────────

/**
 * Constant-time compare. The length difference leaks, which is fine: the
 * secret's length is not the secret. Matches lib/share-tokens.ts.
 */
function timingSafeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * For Vercel Cron endpoints. Verifies `Authorization: Bearer ${CRON_SECRET}`
 * and hands over the raw service client, because a cron sweep is legitimately
 * cross-tenant.
 *
 * Fails closed: a missing CRON_SECRET is a 401, not a skipped check. Otherwise
 * a misconfigured environment turns the endpoint into a public notification
 * spammer.
 */
export function withCron(
  options: { name?: string },
  handler: (ctx: { request: NextRequest; db: SupabaseClient }) => Promise<HandlerResult>
) {
  return async function route(request: NextRequest): Promise<Response> {
    const label = labelFor(request, options.name);

    try {
      const secret = process.env.CRON_SECRET;
      const provided = request.headers.get("authorization");
      if (!secret || !provided || !timingSafeEquals(provided, `Bearer ${secret}`)) {
        throw unauthorized();
      }

      const result = await handler({ request, db: getServiceClient() });
      return toResponse(result);
    } catch (err) {
      return handleError(err, label);
    }
  };
}
