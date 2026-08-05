# Codebase hardening — continuation plan

**Started:** 2026-08-04 · **Last updated:** 2026-08-05 · **Status:** in progress

<!-- plan-metrics
routes-total: 105
routes-wrapped: 36
unwrapped-route: 324
raw-fetch: 55
generic-error-toast: 8
swallowed-error: 6
token-violations: 6
component-tests: 6-->

> These numbers are verified by `npm run lint:plans`, which recomputes them from
> the codebase and fails the build if this plan has drifted. If it fails, fix the
> prose below, then run `npm run lint:plans -- --update`.

## Read this before picking up the queue below

The deployment target is now known: **PACE Technologies, internally, single
tenant** — the BOM of record and change-control system for our equipment line,
with SolidWorks upstream and NetSuite downstream. That was not the assumption
this plan was written under, and it reorders the priorities below.

- **Item 1 (finish the route wrapper) is no longer the highest-value work.** Its
  value is tenant-isolation correctness by construction, and with one tenant a
  missing `tenantId` filter cannot leak to anyone. Still worth doing — it is
  what makes the routes readable and testable — but it is hygiene now, not
  urgency. The same goes for the RLS lockdown, share links, and SSO.
- **~~Trash / undelete is promoted to the top.~~ Shipped 2026-08-05.** See
  [Product gaps](#product-gaps-found-along-the-way) for what it does and does
  not cover — notably folders are still hard-deleted, and nothing purges the
  trash.
- **Two operational items now rank above everything in the queue:** a separate
  development database, and verified backups. Both are in
  [Do these first](#do-these-first-not-code) as items 4 and 5.
- **The SolidWorks and NetSuite seams have their own plan** →
  [`cad-erp-integration.md`](cad-erp-integration.md). Its two "decide before
  loading real data" items get harder with every part entered, so they should be
  settled before this queue is resumed.

Suggested order: ~~undelete~~ → ~~BOM import~~ → **dev database → verify
backups** → item master import (in the integration plan) → then back to item 1
below.

Both remaining operational items are yours to do in the Supabase console; there
is nothing in this repo to change for either.

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

Run these rather than trusting the numbers below. Several agents work this
repo at once, so the counters move between one person reading them and the
next; `npm run lint:plans` is the only reading that is current.

```bash
npm run check                                          # the gate: types, lint, tokens, conventions, tests
node scripts/lint-conventions.mjs --list               # everything outstanding, by rule
node scripts/lint-conventions.mjs --list unwrapped-route
node scripts/lint-tokens.mjs --list
npm run probe:rls                                      # live RLS posture
```

| Metric                                | At session start | Now                                  | Target                                                |
| ------------------------------------- | ---------------- | ------------------------------------ | ----------------------------------------------------- |
| Token violations                      | 373              | **6**                                | 0 (the 6 are marketing gradient blobs; arguably done) |
| Pages on `PageContainer`/`PageHeader` | 0                | **18**                               | — done                                                |
| `StatusBadge` call sites              | 0                | **31**                               | — done, 0 hand-rolled status maps remain              |
| Routes on `withTenant`                | 0                | **36 / 105**                         | 105                                                   |
| `raw-fetch` in client components      | 112              | **55**                               | 0                                                     |
| `generic-error-toast`                 | 14               | **8**                                | 0                                                     |
| `swallowed-error`                     | 11               | **6**                                | 0                                                     |
| Component tests                       | 0                | **4** files (57 stateful components) | the ones with real logic                              |

### How the ratchet works

Both linters compare against `scripts/*.baseline.json`. Existing debt is frozen; a **new** violation fails the build. Fixing violations passes and prints how far the count fell — then run `node scripts/lint-conventions.mjs --update` to lower the baseline in the same commit. **Never raise a baseline to make a build pass.**

---

## Do these first (not code)

**~~1. Check whether migration 012 is actually applied.~~ Resolved 2026-08-05 — it is.** `get_folder_access_scope` exists in the live catalog with the signature `folder-access.ts` calls (`p_tenant_id, p_user_id, p_role_id, p_bypass`). **Folder ACLs are real**, not the no-op the 2026-08-04 reading suggested.

Two things follow, and both are live behaviour rather than trivia:

- **The resolver fails closed.** On a genuine RPC error `folder-access.ts` returns `closedScope`, so a Supabase blip hides folders from non-bypass users rather than exposing them. Intended, but it is a visible change from the open-scope fallback the app was effectively running under while 012 looked missing.
- **Every folder-gated path is now actually gated**, including the trash: its listing post-filters on `canViewFolder` and restore requires `canEditFolder`. A user with view-only access to a folder sees nothing from it in the trash and cannot restore from it.

**If `PGRST202` ever reappears after a function-adding migration, suspect the schema cache before the migration.** PostgREST caches the schema and returns `PGRST202 — function does not exist` for a function that is genuinely there until the cache reloads. That is the most likely explanation for the 2026-08-04 reading. The fix is not to re-run the migration:

```sql
notify pgrst, 'reload schema';
```

**2. Confirm migration 039 is applied.** `npm run probe:rls` passed on 2026-08-04, which implies it is. Re-check after any schema work — the migration files are not a ledger of what is live ([`../decisions/hand-applied-migrations.md`](../decisions/hand-applied-migrations.md)).

**3. Delete the remote `master` branch** once you have confirmed nothing deploys from it. It is fully contained in `main`, so nothing is lost:

```bash
git push origin --delete master
```

**4. Stand up a separate Supabase project for development.** `.env.local`
points at the live project, so dev and prod are the same database and
`npm run dev` edits real BOMs. That was survivable while the data was test
data. Once the equipment line is in there, there is no accident buffer at all.

**5. Confirm backups exist and that a restore works.** Nothing in this repo
addresses Supabase backup posture. For the BOM of record that matters more than
every counter in the table above combined — and an untested restore is not a
backup. Do the restore once, into the dev project from item 4.

---

## The work queue

### 1. Finish the route wrapper — 66 routes

> 70 → 66. Three of those four are new routes that were wrapped from the start
> (the BOM and vendor thumbnail endpoints); one is a genuine conversion —
> `parts/[partId]/thumbnail` was rewritten onto `withTenant` when the shared
> `src/lib/thumbnails.ts` landed, because three copies of the upload rules was
> two too many. That is the shape to copy: convert the handler you are already
> inside, in the same commit as the feature.

Makes tenant isolation correct by construction rather than by review. Note the reprioritisation above: with a single tenant this is readability and testability rather than a live isolation risk, so it no longer outranks the operational items.

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

### 2. Adopt `useFetch` / `fetchJson` — 55 sites

```bash
node scripts/lint-conventions.mjs --list raw-fetch
```

Worst offenders: `vault/file-detail-panel.tsx` (13), `vault/upload-file-dialog.tsx` (7), `providers/notification-provider.tsx` (6), `parts/components/part-form-dialog.tsx` (6), `parts/components/add-vendor-dialog.tsx` (3).

**A perf pass on 2026-08-05 cleared the page-level reads.** `parts/page.tsx`,
`vendors/page.tsx`, `search/page.tsx`, `profile/page.tsx`, `admin/roles`,
`admin/lifecycle`, `admin/workflows`, `admin/metadata`, `admin/settings`,
`admin/users`, `admin/approval-groups` and `boms-view` are all on
`useFetch`/`fetchJson` now, which is what took `raw-fetch` 70 → 55 and
`generic-error-toast` 12 → 8. What is left is **dialogs and providers**, not
pages — a different shape of work:

- `file-detail-panel` and `upload-file-dialog` are upload/streaming flows where
  `uploadFile` (not `useFetch`) is the right target.
- `part-form-dialog`, `add-vendor-dialog`, `link-file-dialog` are
  typeahead searches. `useFetch` handles these well — build the URL from a
  debounced query and let the hook abort the superseded request, the way
  `vendors/page.tsx` and `parts/page.tsx` now do — but each needs its local
  `useDebounce` helper replaced rather than kept alongside.
- `notification-provider` is a long-lived subscription, not a page read.

Two of `parts/page.tsx`'s came out while fixing a bug, and the bug is the argument for the whole item: `loadPartDetail` used bare `fetch` with no staleness guard, so a response that started before a write could land after it and silently revert the UI. `useFetch`/`fetchJson` do not fix that on their own, but the routine that reaches for them is the one that notices.

Reads → `useFetch`. Mutations → `fetchJson` in the handler, then `refetch()`. Always `toast.error(errorMessage(err))` in the catch. Streamed zips still take a `lint-conventions-allow: raw-fetch` comment with the reason; **`FormData` uploads no longer need one** — `uploadFile` in [`src/lib/api-client.ts`](../../src/lib/api-client.ts) hands the FormData to fetch untouched and maps errors the same way `fetchJson` does. → [`../decisions/data-fetching.md`](../decisions/data-fetching.md)

The 14 `generic-error-toast` and 11 `swallowed-error` violations mostly live in the same files, so they fall out of this pass.

### 3. `src/features/` migration

Not started; `src/features/` does not exist yet. The `deep-feature-import` lint rule is already written and waiting. Start with the vault, which is currently spread across five directories. → [`../decisions/feature-folders.md`](../decisions/feature-folders.md)

Do this **after** the route work. It touches import paths everywhere and would collide with everything else in flight.

### 4. Component tests

The jsdom project is configured and working. Two reference files now: `src/components/ui/status-badge.test.tsx` for a pure presentational mapping, and `src/app/(dashboard)/boms/components/import-bom-dialog.test.tsx` for a stateful dialog — the latter is the better model for the list below, since it drives real interactions with `userEvent` and asserts on behaviour (nothing is POSTed before confirmation, the server's own error text reaches the user) rather than markup.

Worth testing, in order: `vault-file-list` (selection, bulk actions), `part-form-dialog` (validation), `add-item-dialog` (quantity maths), `approval-timeline` (state rendering), `mention-input` (parsing). Skip presentational primitives.

`item-source-cell.test.tsx` is a useful third pattern alongside the other two: the component is trivial to render but encodes a precedence rule (sub-assembly before part before file) whose breakage is invisible — it sent every sub-assembly line to the parts list for a day. Small pure-decision components inside big files are worth exporting purely so the decision can be pinned. → [`../decisions/testing-strategy.md`](../decisions/testing-strategy.md)

`entity-thumbnail.test.tsx` is the fourth, and shows where the line sits on a shared primitive: the tile itself is not tested, only the two decisions inside `ThumbnailPicker` — a disabled picker renders no control at all, and re-picking the same file still fires (the input's value is cleared for exactly that reason, and re-uploading after a failure is what breaks without it).

### 5. Split the oversized files

`file-detail-panel.tsx` (~1050 lines) and `search/page.tsx` (~960). Both are doing several jobs. Natural to fold into the `src/features/` move rather than doing separately.

---

## Product gaps found along the way

Not refactors — real missing behaviour, worth their own tickets.

**~~No trash / undelete.~~ Done** (migration 042 + `GET /api/files/deleted` + `POST /api/files/[fileId]/undelete` + the `trash` flat view). Recovering a file no longer needs database access. Three things the next person should know:

- It is **files only**. Folders have no `deletedAt` column, so deleting a folder is still one-way — the delete dialog now says so for folders and promises the trash for files. Extending soft-delete to folders is its own piece of work, and needs a decision about what happens to the files inside.
- Migration 042 made `files_tenantId_folderId_name_key` **partial** on `deletedAt IS NULL`. That fixed a live bug (a deleted file kept reserving its name, so re-uploading the same filename failed with "already exists" about an invisible file) and introduced the collision undelete now returns a 409 for.
- **Nothing purges the trash.** Deleted rows and their storage blobs accumulate forever, and the listing is capped at 200. A retention policy is the obvious follow-up; until then storage grows monotonically.

**~~No confirm on multi-file delete.~~ Already fixed** before this plan was written — `showBulkDeleteConfirm` gates it and `VaultDialogs` renders the AlertDialog. The plan was stale on this point. Its copy claimed the delete was permanent, which is now corrected.

**SolidWorks files can never render in 3D.** `.SLDPRT`/`.SLDDRW` are proprietary OLE binaries; occt-import-js is OpenCascade and reads neutral formats only (`step`, `stp`, `iges`, `igs`, `stl`, `obj`). Only the embedded 2D preview bitmap can be extracted. If real 3D previews matter, uploads need an accompanying STEP export — worth deciding before the vault has 500 files instead of 7.

---

## Conventions worth re-reading before you start

- Every route is wrapped, and the `db` you get is already tenant-scoped → [`../decisions/api-route-contract.md`](../decisions/api-route-contract.md)
- Every new table gets RLS in the migration that creates it → [`../decisions/rls-new-tables.md`](../decisions/rls-new-tables.md)
- Migrations are hand-applied and the files are not a ledger → [`../decisions/hand-applied-migrations.md`](../decisions/hand-applied-migrations.md)
- Tokens only; `/admin/kitchen-sink` (dev only) shows every primitive → [`../decisions/design-tokens.md`](../decisions/design-tokens.md)
