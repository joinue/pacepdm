# Engineering guide: start here

This is the orientation for someone joining PACE PDM. [`README.md`](../README.md) tells you how to run it; [`AGENTS.md`](../AGENTS.md) is the concise rulebook; this document is the tour that connects them and explains the _why_ behind the choices that will surprise you.

Read it once, top to bottom, before your first change.

Everything here is written for both the people and the AI that work on this codebase. `AGENTS.md` and [`docs/decisions/`](decisions/) are the shared rulebook for both.

## What PACE PDM is

Product data management for small and medium hardware teams — the people who currently run their engineering data on a shared network drive and a spreadsheet, and for whom a full PLM suite is too much. The bet is that a lightweight tool can still hold real engineering data: file revisions with check-in/check-out, lifecycle states, multi-level BOMs with cost and quantity rollup, engineering change orders with real approval workflows, releases, vendors, and a complete audit trail.

Multi-tenant SaaS. One customer is one tenant; a user belongs to exactly one tenant.

## The stack, in one breath

Next.js 16 (App Router) on React 19. Supabase for Postgres, Auth, Storage, and realtime. Tailwind v4 with shadcn primitives on `@base-ui/react`. Zod for validation, `sonner` for toasts, `next-themes` for dark mode. `three.js` + `occt-import-js` for the in-browser CAD viewer, `pdfjs-dist` for PDF preview, `@napi-rs/canvas` for server-side thumbnails. Vitest for unit tests, Playwright for E2E.

> This is a **newer Next.js than most references and training data assume.** Read the guides under `node_modules/next/dist/docs/` before writing framework code.

## How the code is laid out

- **`src/features/<feature>/`** owns a feature's components, hooks, and types. Import a feature through its `index.ts`, never its internals. → [`decisions/feature-folders.md`](decisions/feature-folders.md)
- **`src/components/ui/`** holds shared primitives — `Button`, `Dialog`, `Table`, and the layout primitives `PageContainer`, `PageHeader`, `SectionLabel`, `EmptyState`, `StatusBadge`. Compose these; never re-roll their class recipes.
- **`src/components/layout/`** is the app chrome: sidebar, header, global search.
- **`src/lib/`** holds cross-cutting helpers: `api-route.ts` (the route wrapper), `api-client.ts` (`fetchJson`), `auth.ts`, `permissions.ts`, `validation.ts`, and the engines — `approval-engine.ts`, `bom-rollup.ts`, `folder-access.ts`, `status-flows.ts`.
- **`src/app/`** is the App Router tree. Route groups: `(dashboard)` is the signed-in app, `(auth)` is login/signup, `share/[token]` is the public share viewer, `marketing` is the public site.
- **`src/app/api/`** is ~98 route handlers. Every one of them is wrapped. See below.
- **`supabase/migrations/`** is raw SQL applied by hand. **Read [`decisions/hand-applied-migrations.md`](decisions/hand-applied-migrations.md) before you touch it.**

## The things that will surprise you

1. **There are no Server Actions.** Every mutation is a route handler under `src/app/api/`. This is deliberate and consistent; do not introduce Server Actions without a decision doc.

2. **Every route handler is wrapped, and the wrapper hands you a tenant-scoped database client.** You never write `.eq("tenantId", …)`, because you never touch an unscoped client. This is the single most important convention in the codebase and it exists because the alternative already leaked. → [`decisions/api-route-contract.md`](decisions/api-route-contract.md), [`decisions/tenant-isolation.md`](decisions/tenant-isolation.md)

3. **The service role bypasses RLS, so RLS protects nothing the app does.** It protects against `curl`. The anon key ships in the JS bundle, and before `migration-039` an unauthenticated request could read every user's email, every share token, and the entire audit log — and delete them. Every new table gets RLS in the migration that creates it. → [`decisions/rls-new-tables.md`](decisions/rls-new-tables.md)

4. **Migrations are pasted into the Supabase dashboard by hand.** The files describe intent, not reality. They must be idempotent, and you verify what is live by introspecting the database. → [`decisions/hand-applied-migrations.md`](decisions/hand-applied-migrations.md)

5. **Three data-fetching patterns, and the linter enforces them.** Server component fetch, `useFetch`, `fetchJson`. Raw `fetch` in a client component fails the build, as does `catch { toast.error("Failed") }`. These rules existed as prose for months and were ignored 94 times, which is why they are now a gate. → [`decisions/data-fetching.md`](decisions/data-fetching.md)

6. **Tokens only, and a linter enforces that too.** No `text-gray-500`, no `h-[72px]`. Dark mode depends on it. → [`decisions/design-tokens.md`](decisions/design-tokens.md)

7. **Permissions are declared, not checked.** The permission goes in the `withTenant` options. `usePermissions().can()` on the client hides buttons, which is a UX affordance and not a security boundary.

8. **The audit log is append-only and load-bearing.** It is the compliance story for customers in regulated manufacturing. Every state-changing mutation calls `logAudit`.

## Running it

```bash
npm install
npm run dev        # http://localhost:3000
```

Environment variables live in `.env.local` (Supabase URL, anon key, service role key). There is no local database; the app talks to the configured Supabase project.

| Command                    | What it does                                           |
| -------------------------- | ------------------------------------------------------ |
| `npm run dev`              | Dev server                                             |
| `npm test`                 | Vitest unit suite (colocated `*.test.ts(x)`)           |
| `npm run e2e`              | Playwright journeys                                    |
| `npm run typecheck`        | `tsc --noEmit`                                         |
| `npm run lint`             | ESLint                                                 |
| `npm run lint:tokens`      | Design-token discipline                                |
| `npm run lint:conventions` | Data-fetching + import + route-wrapper discipline      |
| `npm run check`            | Everything above. The pre-push gate, and what CI runs. |
| `npm run probe:rls`        | Hits live PostgREST as `anon`; fails on any leaked row |

## Your first change: how the pieces connect

Trace one flow end to end before editing. A good one is **checking a file out of the vault**:

1. **Route** — `src/app/(dashboard)/vault/page.tsx` renders the vault. It is thin: it resolves the tenant user and renders the feature.
2. **Feature** — `src/features/vault/` holds the browser, the file list, the detail panel, and the hooks. `useVaultBrowser` is a facade over seven smaller hooks, each owning one concern (navigation, contents, selection, filter, single-file actions, bulk actions, drag-and-drop). Add behavior to the relevant sub-hook, not the facade.
3. **Read** — the file list gets its data through `useFetch("/api/files?folderId=…")`.
4. **Mutation** — the check-out button calls `fetchJson("/api/files/[fileId]/checkout", { method: "POST" })`, then `refetch()`.
5. **Route handler** — `withTenant({ permission: PERMISSIONS.FILE_CHECKOUT }, …)`. The wrapper has already returned 401 or 403 if it needed to, and the `db` it hands over is tenant-scoped.
6. **Authorization beyond the role** — folder ACLs. `resolveFolderAccess` produces the user's allowed/editable/admin folder sets, and the handler checks the file's folder against them. Role permissions and folder ACLs are two different gates and both apply.
7. **Audit** — `logAudit` records who checked out what, when.
8. **Side effects** — notifications go through `sideEffect(notify(…), "…")` so a failed notification cannot fail the check-out.
9. **Realtime** — other users' vault views update through `useRealtimeTable`, always filtered by `tenantId`.
10. **Tests** — the handler has a case in the tenant-isolation suite; the hook logic has a unit test.

## The golden path for a new feature

1. **Model the data** in an additive, idempotent migration. Enable RLS in the same migration. Apply it by hand and verify by introspection.
2. **Write the route handlers** with `withTenant`. Declare the permission, validate with Zod, use the scoped `db`, call `logAudit`, wrap side effects.
3. **Create `src/features/<name>/`** with an `index.ts` barrel.
4. **Compose the UI** from `src/components/ui/` primitives with token utilities. `PageContainer` + `PageHeader` for the page shell.
5. **Fetch with the sanctioned patterns.** Never raw `fetch` in a component; always `errorMessage(err)` in the catch.
6. **Provide `loading.tsx` / `error.tsx` / `not-found.tsx`** for the new route segment.
7. **Gate the UI** with `usePermissions().can()`, remembering it is cosmetic.
8. **Test** the engine logic, the route's auth paths, and any component with real logic. Add the route to the tenant-isolation suite if it resolves records by id.
9. **Add the new table to `scripts/rls-probe.mjs`.**
10. **If you made a decision the next person must follow, write it down** in [`decisions/`](decisions/) and link it from the code.
11. **Run `npm run check`.** Commit with a concise, human message and no AI attribution.

## Where to find things

| You want                             | Look at                                                    |
| ------------------------------------ | ---------------------------------------------------------- |
| The rules, concisely                 | [`../AGENTS.md`](../AGENTS.md)                             |
| The "why" behind a rule              | [`decisions/`](decisions/)                                 |
| What a PDM term means                | [`GLOSSARY.md`](GLOSSARY.md)                               |
| Every UI primitive, previewed        | `/admin/kitchen-sink` (admin-gated)                        |
| The state machines                   | [`../src/lib/status-flows.ts`](../src/lib/status-flows.ts) |
| What permissions exist               | [`../src/lib/permissions.ts`](../src/lib/permissions.ts)   |
| Whether a migration is actually live | Introspect the database. Not the files.                    |
