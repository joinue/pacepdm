# Testing strategy

**Status:** active

## What must be tested

**1. Business logic and engines.** The parts of the system where a wrong answer is silent and expensive:

- `approval-engine.ts` — who is asked to approve what, in which order, and what happens on rejection.
- `bom-rollup.ts` — quantity and cost rollup through nested BOM levels.
- `folder-access.ts` — the ACL resolver. A bug here is a permission bug.
- `permissions.ts` — especially `permissionsExceedingActor`, which is the privilege-escalation guard.
- `status-flows.ts` — which transitions are legal from which state.

**2. Route handlers.** Every route that resolves a record by id, and every route that mutates. Test with a mocked Supabase client (see below). At minimum: the 401 path, the 403 path, the cross-tenant 404, and the happy path.

**3. Interactive components with real logic.** A component that computes, filters, validates, or manages a state machine. `vault-file-list` (selection and bulk actions), `part-form-dialog` (validation), `add-item-dialog` (quantity math), `approval-timeline` (state rendering), `mention-input` (parsing).

**4. Full journeys, in Playwright.** Upload → check out → check in. ECO draft → submit → approve → release. Share link create → open as anonymous → download.

## What must not be tested

Presentational primitives with no logic. A test that asserts `<Badge>` renders its children inside a `<span>` costs maintenance and catches nothing. If the component has no branch, no state, and no computation, skip it.

**Test behavior, not markup.** Query by role and label, not by class name. A test that breaks when you rename a CSS class is a test that will be deleted rather than fixed.

## Why route handlers use a mocked Supabase client

The alternative is a live test database, which buys real SQL semantics at the cost of a schema to keep in sync, seed data to maintain, cleanup between tests, and a CI service container. For a project where migrations are applied by hand ([`hand-applied-migrations.md`](hand-applied-migrations.md)), the "keep the test schema in sync" cost is the one we can least afford — the test database would drift from production and produce confident, wrong results.

The mock in [`src/app/api/tenant-isolation.test.ts`](../../src/app/api/tenant-isolation.test.ts) takes a sharper approach than a stub: it **records the filters the route applied** and lets the test assert on them. That is how it can verify that a list route actually called `.eq("tenantId", …)` rather than just that it returned an empty array. That property is the reason the mock earns its keep, and new route tests should use it the same way.

The tradeoff is explicit: these tests verify the handler's logic and its authorization decisions. They do not verify that the SQL is valid. Playwright covers that end of it.

## The two tenant-guard styles, and which to write

The existing tests distinguish:

1. **SQL-level guard** — the query carries `.eq("tenantId", …)`, so a cross-tenant row never comes back.
2. **Application-level guard** — the query fetches by id, then the handler compares `row.tenantId` in JavaScript.

New code produces style 1 automatically, because the scoped client from `withTenant` applies the filter ([`api-route-contract.md`](api-route-contract.md)). Style 2 exists in older routes and is tested so a refactor cannot silently drop it. Do not write new style-2 guards.

## Running

| Command                 | What                |
| ----------------------- | ------------------- |
| `npm test`              | Vitest, once        |
| `npm run test:watch`    | Vitest, watching    |
| `npm run test:coverage` | With V8 coverage    |
| `npm run e2e`           | Playwright journeys |
| `npm run check`         | Everything CI runs  |

Tests colocate with their source as `*.test.ts(x)`. A test far from its subject gets stale.

## Consequences

- A PR touching `approval-engine`, `bom-rollup`, `folder-access`, or `permissions` without a test change should be questioned.
- A new route that resolves a record by id adds a case to the tenant-isolation suite. That file is the registry of what is proven safe.
- Coverage is not a target. The list at the top of this file is the target.
