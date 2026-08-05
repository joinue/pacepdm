# Codebase hardening — continuation plan

**Started:** 2026-08-04 · **Last updated:** 2026-08-04 · **Status:** in progress

<!-- plan-metrics
routes-total: 98
routes-wrapped: 28
unwrapped-route: 330
raw-fetch: 112
generic-error-toast: 14
swallowed-error: 11
token-violations: 6
component-tests: 1
-->

> These numbers are verified by `npm run lint:plans`, which recomputes them from
> the codebase and fails the build if this plan has drifted. If it fails, fix the
> prose below, then run `npm run lint:plans -- --update`.

The foundations are in and pushed to `main` (`9695e8d`). What remains is volume, not design: every outstanding item is mechanical, has a counter that can only go down, and can be picked up and put down without losing your place.

**Read [`../ENGINEERING.md`](../ENGINEERING.md) and [`../../AGENTS.md`](../../AGENTS.md) first if you are coming to this cold.**

---

## Picking this up on another machine

```bash
git clone https://github.com/joinue/pacepdm.git
cd pacepdm
npm install                # `prepare` wires up the husky pre-commit hook
cp .env.example .env.local # then fill in the Supabase keys
npm run check              # should be green before you change anything
npm run dev
```

Two things that bite on a fresh clone:

- **The pre-commit hook only exists after `npm install`.** Until then nothing gates your commits.
- **There is no local database.** `.env.local` points at the live Supabase project, so `npm run dev` is talking to production data. Be careful with destructive testing.

---

## Where things stand

Run these rather than trusting the numbers below — they are a snapshot from 2026-08-04.

```bash
npm run check                                          # the gate: types, lint, tokens, conventions, tests
node scripts/lint-conventions.mjs --list               # everything outstanding, by rule
node scripts/lint-conventions.mjs --list unwrapped-route
node scripts/lint-tokens.mjs --list
npm run probe:rls                                      # live RLS posture
```

| Metric                                | At session start | Now                                 | Target                                                |
| ------------------------------------- | ---------------- | ----------------------------------- | ----------------------------------------------------- |
| Token violations                      | 373              | **6**                               | 0 (the 6 are marketing gradient blobs; arguably done) |
| Pages on `PageContainer`/`PageHeader` | 0                | **18**                              | — done                                                |
| `StatusBadge` call sites              | 0                | **31**                              | — done, 0 hand-rolled status maps remain              |
| Routes on `withTenant`                | 0                | **28 / 98**                         | 98                                                    |
| `raw-fetch` in client components      | 112              | **112**                             | 0                                                     |
| `generic-error-toast`                 | 14               | **14**                              | 0                                                     |
| `swallowed-error`                     | 11               | **11**                              | 0                                                     |
| Component tests                       | 0                | **1** file (57 stateful components) | the ones with real logic                              |

### How the ratchet works

Both linters compare against `scripts/*.baseline.json`. Existing debt is frozen; a **new** violation fails the build. Fixing violations passes and prints how far the count fell — then run `node scripts/lint-conventions.mjs --update` to lower the baseline in the same commit. **Never raise a baseline to make a build pass.**

---

## Do these first (not code)

**1. Check whether migration 012 is actually applied.** `get_folder_access_scope` returned `PGRST202 — function does not exist` on 2026-08-04, which means **folder ACLs currently do nothing**. The resolver falls back to an open scope, so the folder-access dialog will let you grant and revoke access with no effect. Verify against the live catalog, and apply `migration-012` if it is genuinely missing:

```sql
select proname from pg_proc where proname = 'get_folder_access_scope';
```

Note the follow-on: once 012 _is_ applied, `folder-access.ts` fails **closed** on a real RPC error (`closedScope`), so a database blip will hide folders from non-bypass users rather than exposing them. That is intended, but it is a visible change in failure behaviour.

**2. Confirm migration 039 is applied.** `npm run probe:rls` passed on 2026-08-04, which implies it is. Re-check after any schema work — the migration files are not a ledger of what is live ([`../decisions/hand-applied-migrations.md`](../decisions/hand-applied-migrations.md)).

**3. Delete the remote `master` branch** once you have confirmed nothing deploys from it. It is fully contained in `main`, so nothing is lost:

```bash
git push origin --delete master
```

---

## The work queue

### 1. Finish the route wrapper — 70 routes

Highest value: it is what makes tenant isolation correct by construction rather than by review.

```bash
node scripts/lint-conventions.mjs --list unwrapped-route
```

Remaining by domain: `files` 16, `parts` 7, `boms` 6, `lifecycle` 5, `workflows` 4, `folders` 4, `ecos` 4, `admin` 4, `public` 3, `approval-groups` 3, then singles.

**Convert a whole domain at a time, not individual handlers.** Routes within a domain share helpers and permission choices, and splitting one across two styles is how a guard gets dropped.

The pattern, with `src/app/api/vendors/[vendorId]/route.ts` as the reference:

```ts
const ParamsSchema = z.object({ vendorId: uuid });

export const GET = withTenant({ params: ParamsSchema }, async ({ db, params }) => {
  const { data } = await db.from("vendors").select("*").eq("id", params.vendorId).maybeSingle();
  if (!data) throw notFound("Vendor not found");
  return data; // plain value → 200 JSON
});
```

For file routes use **`loadFile(db, tenantUser, fileId, "view" | "edit")`** — it applies the tenant filter, the soft-delete exclusion, and the folder ACL check in one call. That is the preamble 19 file routes each used to write by hand.

Things that will trip you up:

- **Child tables have no `tenantId`.** `bom_items`, `file_versions`, `eco_items` and friends pass through the scoped client **unfiltered**. Load the parent through `db` first, then query the child by the parent's id, and record why with a `lint-conventions-allow: child-table-direct-query` comment. The linter will ask.
- **Params are validated as UUIDs.** A route test using `"eco-1"` now correctly gets a 400. Fixtures need real UUIDs.
- **Roughly a third of routes have tests written against the old shape.** Rewrite them rather than patching: several had mocks that ignored `.eq()` filters, so their "cross-tenant" cases would have passed with or without the scoping. `src/app/api/files/[fileId]/checkout/route.test.ts` is the reference for a mock that honours filters.
- **Helpers that take a raw client** (`captureBomSnapshot`, `getFileWhereUsed`, `getReleaseById`) need `db.unscoped("reason")`. They scope by the `tenantId` you pass them.
- **Add a case to `src/app/api/tenant-isolation.test.ts`** for any route that resolves a record by id. That file is the registry of what is proven safe.

### 2. Adopt `useFetch` / `fetchJson` — 112 sites

```bash
node scripts/lint-conventions.mjs --list raw-fetch
```

Worst offenders: `vault/file-detail-panel.tsx` (13), `admin/workflows/page.tsx` (10), `parts/page.tsx` (9), `parts/components/part-form-dialog.tsx` (8), `vault/upload-file-dialog.tsx` (7), `admin/lifecycle/page.tsx` (7).

Reads → `useFetch`. Mutations → `fetchJson` in the handler, then `refetch()`. Always `toast.error(errorMessage(err))` in the catch. Legitimate exceptions (streamed zips, `FormData` uploads) take a `lint-conventions-allow: raw-fetch` comment with the reason. → [`../decisions/data-fetching.md`](../decisions/data-fetching.md)

The 14 `generic-error-toast` and 11 `swallowed-error` violations mostly live in the same files, so they fall out of this pass.

### 3. `src/features/` migration

Not started; `src/features/` does not exist yet. The `deep-feature-import` lint rule is already written and waiting. Start with the vault, which is currently spread across five directories. → [`../decisions/feature-folders.md`](../decisions/feature-folders.md)

Do this **after** the route work. It touches import paths everywhere and would collide with everything else in flight.

### 4. Component tests

The jsdom project is configured and working (`src/components/ui/status-badge.test.tsx` is the reference). One test file against 57 stateful components.

Worth testing, in order: `vault-file-list` (selection, bulk actions), `part-form-dialog` (validation), `add-item-dialog` (quantity maths), `approval-timeline` (state rendering), `mention-input` (parsing). Skip presentational primitives. → [`../decisions/testing-strategy.md`](../decisions/testing-strategy.md)

### 5. Split the oversized files

`file-detail-panel.tsx` (~1050 lines) and `search/page.tsx` (~960). Both are doing several jobs. Natural to fold into the `src/features/` move rather than doing separately.

---

## Product gaps found along the way

Not refactors — real missing behaviour, worth their own tickets.

**No trash / undelete.** Deleting a file is one-way from the UI even though the row and the storage blob both survive. `files/route.ts` always filters `.is("deletedAt", null)`, and `files/[fileId]/restore` restores an older _version_, not a deleted file — it explicitly 404s when `deletedAt` is set. Three files had to be recovered by hand with SQL during this session.

Roughly: a `?deleted=1` filter on the list, a `POST /api/files/[fileId]/undelete`, and a "Recently deleted" tab in the vault. Small, and it stops the next recovery needing database access.

**No confirm on multi-file delete.** Seven files were deleted in 45 seconds in May, which reads like clicking through without friction.

**SolidWorks files can never render in 3D.** `.SLDPRT`/`.SLDDRW` are proprietary OLE binaries; occt-import-js is OpenCascade and reads neutral formats only (`step`, `stp`, `iges`, `igs`, `stl`, `obj`). Only the embedded 2D preview bitmap can be extracted. If real 3D previews matter, uploads need an accompanying STEP export — worth deciding before the vault has 500 files instead of 7.

---

## Conventions worth re-reading before you start

- Every route is wrapped, and the `db` you get is already tenant-scoped → [`../decisions/api-route-contract.md`](../decisions/api-route-contract.md)
- Every new table gets RLS in the migration that creates it → [`../decisions/rls-new-tables.md`](../decisions/rls-new-tables.md)
- Migrations are hand-applied and the files are not a ledger → [`../decisions/hand-applied-migrations.md`](../decisions/hand-applied-migrations.md)
- Tokens only; `/admin/kitchen-sink` (dev only) shows every primitive → [`../decisions/design-tokens.md`](../decisions/design-tokens.md)
