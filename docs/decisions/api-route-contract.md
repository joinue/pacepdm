# Every API route is wrapped

**Status:** active
**Applies to:** every file under `src/app/api/`

## The problem

This app has ~98 route files. Before this decision, each one opened the same way:

```ts
export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const parsed = await parseBody(request, Schema);
    if (!parsed.ok) return parsed.response;
    const db = getServiceClient();
    // ... eight lines in, the actual work starts
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to X";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

Eight lines of ceremony, repeated 98 times, none of it type-checked as a unit. Three things went wrong with that:

1. **The tenant filter was optional.** `getServiceClient()` returns a service-role client that bypasses RLS entirely, so a query without `.eq("tenantId", …)` reads every tenant's rows. Across the API there were 402 table calls and 130 tenant filters. Most of the gap was legitimate (nested scoping through an already-scoped parent), but the shape made a missing filter invisible during review. Commit `fb6c1cc` ("close cross-tenant authz holes in approvals, workflows, and roles") is what that costs.
2. **Permission checks drifted.** Some routes checked, some did not, and there was no way to see which from the outside.
3. **Nothing was uniform enough to test once.** Each route had its own error shape and its own 401 path.

## The decision

A single wrapper owns the contract. `withTenant` in [`src/lib/api-route.ts`](../../src/lib/api-route.ts):

- Resolves the session, returning 401 with a uniform body if absent.
- Checks the declared permission, returning 403 if missing.
- Parses and validates the body / query with Zod, returning 400 with a field-level error map.
- Hands the handler a **tenant-scoped data client** where the filter is applied by construction.
- Catches `ApiFailure` subclasses and maps them to their status; catches anything else, logs it with route context, and returns 500 with the real message.

The route declares what it needs and then does its work:

```ts
export const POST = withTenant(
  { permission: PERMISSIONS.FILE_EDIT, body: CreateBomSchema },
  async ({ db, tenantUser, body }) => { ... }
);
```

## Why a scoped client rather than a lint rule

A lint rule can only see syntax. It cannot tell `.eq("tenantId", tenantUser.tenantId)` on the parent query from a child query that inherits scope through a foreign key, so it would either miss real leaks or cry wolf on every nested read. Making the scoped client the only thing in reach removes the decision instead of policing it. The escape hatch (`db.unscoped()`) is greppable, which is the property that actually matters: you can enumerate every deliberate cross-tenant read in one search.

## Alternatives rejected

- **Next.js middleware.** Runs before the route but cannot inject a typed client into the handler, and the tenant resolution needs a database round trip that we do not want on every static asset request.
- **Relying on RLS with a per-request JWT.** The correct long-term posture, and `migration-022` already sets up a tenant claim for it. But it requires the anon client everywhere, which changes every query's failure mode at once. The wrapper is the step that makes that migration possible later: when the client swaps, only `api-route.ts` changes.
- **Leaving it and adding tests.** `src/app/api/tenant-isolation.test.ts` already does this for four routes. Tests catch regressions in what they cover; they do not make the other 94 routes correct.

## Migration status

The wrapper is in place and is the rule for all new code. The existing routes are being converted a domain at a time; converted so far: vendors, roles, saved searches, metadata fields, notifications, settings, profile, user search, health.

The remainder is tracked mechanically rather than in prose. `npm run lint:conventions` counts every route that still resolves its own auth, and freezes that count in `scripts/conventions.baseline.json`. So:

- a new route that skips the wrapper fails the build immediately
- converting a route lowers the count, and the linter says so
- the job is finished when the `unwrapped-route` entries reach zero

To see what is left:

```
node scripts/lint-conventions.mjs --list unwrapped-route
```

Convert whole domains, not individual handlers — the routes within a domain share helper functions and permission choices, and splitting one across two styles is how a guard gets dropped.

## Consequences

- **A new route starts from the wrapper.** If you find yourself importing `getApiTenantUser` or `getServiceClient` into a route file, stop: you are rebuilding the thing that exists.
- **`db.unscoped()` requires a comment saying why.** Legitimate uses: resolving a share token before a tenant is known, the SSO domain lookup, cron jobs that sweep across tenants.
- **Public routes are an explicit list.** `withPublicRoute` exists for login, SSO resolve, health, cron, and the public share viewer. Adding to that list is a review-worthy change.
- **Expected failures throw, they do not return.** `throw notFound("File not found")` instead of `return NextResponse.json(...)`. This keeps handler bodies linear and means the error shape is decided in one place.
