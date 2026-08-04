# Tenant isolation

**Status:** active
**Applies to:** every query against a table with a `tenantId` column

## The model

Every customer is a `tenants` row. Every person is a `tenant_users` row joining an `authUserId` to a tenant and a role. A user belongs to exactly one tenant; there is no cross-tenant membership and no tenant switcher. `resolveTenantUser` in [`src/lib/auth.ts`](../../src/lib/auth.ts) is the only place that maps a session to a tenant, and an existing row always wins over JIT SSO provisioning (block semantics — we never migrate a user between tenants).

Almost every other table carries a `tenantId`. The tenant boundary is therefore a _query-level_ concern, not a schema-level one, which is exactly what makes it easy to get wrong.

## The rules

**1. The tenant comes from the session. Always.**

Never accept a tenant id from a request body, query string, or header, even from an admin. There is no legitimate flow where the client tells the server which tenant it is in. If a route appears to need one, it wants `db.unscoped()` and a decision doc of its own.

**2. Scoping is applied by the data client, not by each query.**

The `db` handed to a route handler by `withTenant` filters reads and stamps writes automatically. See [`api-route-contract.md`](api-route-contract.md). Hand-written `.eq("tenantId", …)` in a route is a sign the route is not wrapped.

**3. Fetching by primary key is not safe.**

This is the failure that actually shipped. UUIDs are unguessable, but "unguessable" is not an authorization model — ids leak through share links, audit exports, error messages, and support tickets. A read of the form:

```ts
db.from("ecos").select("*").eq("id", ecoId).single();
```

returns another tenant's ECO if the caller holds its id. Every by-id read must be scoped, and under the wrapper it is.

**4. Nested resources inherit scope through the parent, and the parent must be loaded first.**

To load the items of a BOM, load the BOM (scoped) and then its items by `bomId`. Do not load items by `bomId` alone and assume the id came from somewhere trustworthy.

**5. Application-level guards are a fallback, not a pattern.**

Some existing routes fetch by id and then compare `row.tenantId === tenantUser.tenantId` in JavaScript. That works and is tested, but it is strictly worse than a SQL filter: the row crosses the boundary into process memory before being rejected, so a logging statement or an error message that echoes the row leaks it. New code uses the scoped client. Existing application-level guards stay until their route is migrated.

## What backs it up

Three independent layers, in order of how much you should rely on them:

1. **The scoped client** — the primary control. Correct by construction.
2. **`src/app/api/tenant-isolation.test.ts`** — asserts that a caller in tenant A gets a 404, not a payload, when holding a tenant B id. Extend it whenever you add a route that resolves a record by id.
3. **RLS** — the backstop for anything that bypasses the app entirely. See [`rls-new-tables.md`](rls-new-tables.md). Note that RLS does _not_ protect against a missing filter in app code, because the service role bypasses it. RLS and the scoped client defend against different attackers.

## Consequences

- A new table with a `tenantId` column must be registered in the scoped client's table list, or the wrapper will not know to filter it. The list is the one place to update.
- A new table _without_ a `tenantId` column needs a written reason. Global lookup data (file type catalogs, unit definitions) qualifies. Anything user-generated does not.
- Cross-tenant reads are enumerable: `grep -rn "unscoped()" src/`. Keep that list short and commented.
