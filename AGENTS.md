<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:pace-conventions -->

# PACE PDM engineering conventions

Multi-tenant PDM (product data management) for small and medium hardware teams: a file vault with check-in/check-out and lifecycle states, BOMs, ECOs with approval workflows, releases, and an audit trail.

New here? Read [`docs/ENGINEERING.md`](docs/ENGINEERING.md) first (the engineering tour). This file is the concise rulebook, for people and AI alike. The full rationale behind each standing decision lives in [`docs/decisions/`](docs/decisions/).

## Architecture

- Next 16 App Router on React 19. Reads happen in server components where possible; everything mutating goes through a **route handler under `src/app/api/`**. This app does not use Server Actions — do not introduce them without a decision doc.
- `src/app/(dashboard)/` is the signed-in app, `src/app/(auth)/` is login/signup, `src/app/share/[token]/` is the public share viewer, `src/app/marketing/` is the public site.
- Feature code lives in `src/features/<feature>/`, which owns its components, hooks, types, and client-side data access. Shared primitives live in `src/components/ui/`. Cross-cutting helpers in `src/lib/`. App chrome in `src/components/layout/`.
- Compose screens from primitives. Never re-roll a primitive's class recipe inside a feature, and never restyle a primitive from its call site beyond layout (margin/width) utilities.

## Every API route is wrapped (this is the single most important rule)

**Never hand-roll auth, tenant scoping, permission checks, or the try/catch in a route handler.** Use `withTenant` from [`src/lib/api-route.ts`](src/lib/api-route.ts):

```ts
export const POST = withTenant(
  { permission: PERMISSIONS.FILE_EDIT, body: CreateBomSchema },
  async ({ db, tenantUser, body }) => {
    const bom = await db.insert("boms", { name: body.name, revision: "A" });
    return NextResponse.json(bom);
  }
);
```

The wrapper resolves the session (401 if absent), checks the permission (403 if missing), validates the body with Zod (400 with a field-level error map), catches throws and surfaces the real message, and — critically — hands you a **tenant-scoped database client**. `db.from("boms")` is already filtered to the caller's tenant on read and stamps `tenantId` on write. You cannot forget the filter, because you never write it.

- Reaching for the raw `getServiceClient()` inside a route means you are deliberately going cross-tenant. That requires `db.unscoped(reason)` with a reason string, and the conventions linter will fail the build on a bare import.
- **Older routes have not all been converted yet.** They resolve auth by hand and are frozen in `scripts/conventions.baseline.json`; `node scripts/lint-conventions.mjs --list unwrapped-route` shows what is left. Do not copy their shape when writing something new, and convert the domain you are touching rather than adding to it.
- Throw `ApiFailure` (`badRequest`, `notFound`, `forbidden`, `conflict`) for expected failures. The wrapper maps them to the right status. Throw anything else only for genuine bugs.
- Routes that must run before a tenant exists (login, SSO resolve, health, cron, public share) use `withPublicRoute` and are listed explicitly in the wrapper's docs.

## Tenant isolation

- Every table with a `tenantId` column is tenant-scoped, and every query against it must be filtered. The wrapper does this for you. See [`docs/decisions/tenant-isolation.md`](docs/decisions/tenant-isolation.md).
- Never trust a tenant identifier that arrived from the client. The tenant is derived from the session, always.
- Reading a record by id is not enough. `.eq("id", id)` without `.eq("tenantId", …)` is a cross-tenant read, and this class of bug has already shipped here once (commit `fb6c1cc`).

## Row-level security

- RLS is the backstop against raw PostgREST access, not the app's primary authorization. The anon key ships in the JS bundle, so it is public by definition.
- **Every new table gets RLS enabled in the same migration that creates it.** Deny-all (RLS on, no policies) is the correct default for a table only ever reached through server code via the service role. Add a policy only when the browser genuinely needs direct access, and scope it to the tenant claim.
- Verify with `npm run probe:rls`, which hits the live PostgREST endpoint as `anon` and fails on any readable row or accepted write. Add new tables to its list. See [`docs/decisions/rls-new-tables.md`](docs/decisions/rls-new-tables.md).

## Migrations are hand-applied

- Migrations are raw SQL in `supabase/migrations/migration-NNN-*.sql`, applied by pasting into the Supabase SQL editor. Not `prisma migrate`, not `supabase db push`.
- They must be **idempotent and re-runnable** (`if not exists`, `drop policy if exists` before `create policy`), because the owner may paste one twice.
- The migration files are not a ledger of what is live. Verify by introspecting the database before assuming a migration has been applied. See [`docs/decisions/hand-applied-migrations.md`](docs/decisions/hand-applied-migrations.md).
- Lead every migration with a comment block explaining what it closes or enables and what was verified. `migration-039-rls-lockdown.sql` is the reference example.

## Data fetching from the client

Pick the pattern that matches the context. Full rationale in [`docs/decisions/data-fetching.md`](docs/decisions/data-fetching.md).

- **Server component** — fetch directly in the async page component and pass data down. Default for read-mostly pages. Add a `loading.tsx` beside the page.
- **Client component reads** — `useFetch` ([`src/hooks/use-fetch.ts`](src/hooks/use-fetch.ts)). It handles aborts, error surfacing, and refetch. Do not write `useState + useEffect + fetch` by hand.
- **Mutations** — `fetchJson` ([`src/lib/api-client.ts`](src/lib/api-client.ts)) in the event handler, then `refetch()`.
- **Never**: bare `fetch(url).then(r => r.json())`, `.catch(() => {})`, or `catch { toast.error("Failed") }`. Always surface the server's message via `errorMessage(err)`. The conventions linter enforces this.

## Permissions

- The server is the boundary. Declare the permission in the `withTenant` options; never check it by hand inside the handler.
- Client-side gating with `usePermissions().can(...)` hides buttons the user cannot use. That is a UX affordance, not a security control.
- A route that authors roles must call `permissionsExceedingActor` so an admin cannot mint a role more powerful than their own.

## Styling and tokens

- Tailwind v4 with shadcn tokens in `src/app/globals.css`. Use semantic token utilities: `bg-background`, `text-muted-foreground`, `border-border`, `bg-card`, `text-destructive`.
- **No raw palette classes** (`text-gray-500`, `bg-red-100`) and **no arbitrary pixel values** (`h-[72px]`, `text-[13px]`). Use a token or the spacing scale. Status colors come from the shared status token map, not from ad-hoc `bg-green-100` on each call site.
- `npm run lint:tokens` fails the build on violations. The allowlist is a decision, not a default.

## Layout primitives

Compose these instead of re-deriving page chrome (see them all at `/admin/kitchen-sink`, admin-gated):

- `PageContainer` — the page's max width, padding, and vertical rhythm.
- `PageHeader` — title, description, and action slot. Every dashboard page uses it; no page hand-rolls an `<h1 className="text-2xl font-semibold">`.
- `SectionLabel`, `EmptyState`, `Skeleton`, `ErrorBoundary`, `StatusBadge`, `DataToolbar`.

## Route segments

Every route segment provides what it needs to fail gracefully:

- `loading.tsx` wherever a server component fetches.
- `error.tsx` for any segment that can throw.
- `not-found.tsx` for dynamic segments that resolve a record by id.

Wrap heavy feature subtrees (the file detail panel, the BOM editor) in `<ErrorBoundary>` so one crash does not blank the page. Do not wrap the whole app.

## Side effects

Non-critical async work that runs _after_ a mutation (notifications, mention processing, thumbnail regeneration) is wrapped in `sideEffect` from [`src/lib/notifications.ts`](src/lib/notifications.ts) so a failure is logged with context instead of failing the request or vanishing.

## Audit logging

Every mutation that changes tenant-visible state calls `logAudit`. Audit rows are append-only and are what the compliance story rests on. Read access is gated behind `PERMISSIONS.AUDIT_VIEW`, not general admin.

## State machines

BOM and ECO status transitions live in [`src/lib/status-flows.ts`](src/lib/status-flows.ts). Both the UI and the routes import from there. Never inline a second copy of a flow.

## Idempotency

Creation routes that a client may retry accept an `idempotency-key` header and persist it as `clientRequestKey`. Handle both the pre-check hit and the `23505` unique-violation race. `src/app/api/boms/route.ts` is the reference implementation.

## Testing

- Vitest + React Testing Library. Tests colocate next to their source as `*.test.ts(x)`. Run `npm test`.
- **Always test**: route handlers (with a mocked Supabase client), business logic and engines (`approval-engine`, `bom-rollup`, `folder-access`, `permissions`), and interactive components with real logic.
- Test behavior, not markup. Skip trivial presentational primitives.
- Playwright E2E in `e2e/` for full journeys (upload → check out → check in, ECO submit → approve).

## Before you commit

`npm run check` (typecheck + lint + token lint + conventions lint + tests) is the gate. The pre-commit hook runs a fast subset; CI runs the whole thing.

Never add AI attribution or `Co-Authored-By` trailers to commit messages. Keep them concise and human.
<!-- END:pace-conventions -->
