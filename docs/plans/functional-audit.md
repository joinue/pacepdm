# Functional audit — what was broken, and what it says about the codebase

**Started:** 2026-08-05 · **Last updated:** 2026-08-07 · **Status:** items 1, 2 and 4–6 closed; item 3 open by nature

<!-- plan-metrics
unchecked-delete: 0
unchecked-insert: 0
unchecked-update: 0-->

A workflow-by-workflow audit against the **live database**, not against the
migration files or the tests. Prompted by `eco_items.bomId`: the column, the
FK, the index, the picker and the API all existed and agreed with each other,
and every insert had still been rejected for a day by a CHECK constraint
nobody re-read.

Seven findings across twelve areas. Every one was invisible to
`npm run check`.

**Read this before adding features.** Five of the seven were governance or
correctness holes — in the change-control story this product exists for, or in
who is allowed to weaken it.

---

## What was found

### 1. `POST /api/boms/[bomId]/revise` failed on every call with an ECO

Three faults stacked, each hidden behind the one in front:

1. Stale two-column CHECK rejecting BOM-only `eco_items` rows (23514)
2. Wrote `eco_items.createdAt` — no such column (PGRST204)
3. Omitted `changeType` — NOT NULL, no default (23502)

All three surfaced through the same branch, which was written for "the user
typed a bad ECO id" and returns a soft `warning` in the response body rather
than throwing. A hard schema rejection read as a mild note.

Fixed in migrations 049 and the route. **The branch now logs an error too** —
that is the general lesson, below.

### 2. `ECO_APPROVE` was never enforced

Defined in `PERMISSION_INFO`, granted to Admin and Manager in
`DEFAULT_ROLES`, asserted in `permissions.test.ts`, read by nothing.

On its own a dead constant. What made it matter: `findWorkflowForTrigger`
falls through to a **direct status update** when no workflow is assigned, and
no tenant is seeded with an ECO workflow — the assignment created at tenant
creation carries a `transitionId` and a null `ecoTrigger`, so it covers a file
transition. The gate was not unenforced, it was absent.

One Engineer could take an ECO `DRAFT → SUBMITTED → IN_REVIEW → APPROVED`
alone and implement it, which releases parts, freezes files and releases the
BOM revisions it carries.

Entering `APPROVED` or `REJECTED` now requires the permission.

### 3. Releasing a BOM needed only `file.edit`

`DRAFT → IN_REVIEW → APPROVED → RELEASED` was three PUTs from anyone who
could rename the thing. The two middle states were decoration.

The argument is not about BOMs, it is the asymmetry: in the same tenant a
_drawing_ cannot reach Released without a workflow and a member of the
Approvers group signing it. The bill of materials that drives purchasing
needed less than the drawing did.

`RELEASED` and `OBSOLETE` now require `ECO_APPROVE`, matching the ECO split.

**Findings 2 and 3 compound.** There were two independent unreviewed paths to
releasing the BOM of record, and migration 049's justification for releasing
a BOM straight from DRAFT — "the ECO's approval is the review" — rested on the
other one being enforced. It was not.

### 4. `ALL` and `MAJORITY` approval modes deadlocked permanently

A decision row records exactly one decider; `startWorkflow` created one row
per **step** regardless of mode. The first approver claimed it, the
"everyone approved" test could never see a second decider, and no one else
could act because the row was no longer `PENDING`. The request sat `PENDING`
with no exit but a recall, and the entity stayed stuck pre-transition.

ALL broke at ≥2 members, MAJORITY at ≥3. Both are offered in
Admin → Workflows with descriptions promising what could not happen.

The previous code carried three comments talking itself through the problem
(`"Actually, in ALL mode with a single decision row…"`, `"Let's track it
differently"`, `"For now"`) and then did not solve it.

Steps in those modes now get one row per group member.

### 5. A failed folder delete reported success and wrote a false audit row

`files_folderId_fkey` is `ON DELETE RESTRICT`, and the emptiness check
filtered `deletedAt IS NULL` — so a folder holding only trashed files looked
empty. Postgres refused the delete. The route discarded the error, returned
`{ success: true }`, and wrote a `folder.delete` audit entry.

The audit log is what the compliance story rests on. A false entry in it is
worse than the failed delete.

### 6. Inviting a user had no privilege ceiling

`permissionsExceedingActor` is the guard that stops anyone handing out a role
more powerful than their own. `users/[userId]` called it on role _changes_.
`users/invite` assigns a role too — to a user who does not exist yet — and did
not. Neither did `admin/sso`, where `jitRoleId` is the role every future SSO
user from a domain is provisioned into.

The invite gap was reachable on the seeded roles rather than only in theory:
`ADMIN_USERS` gates the route, and **Manager holds `ADMIN_USERS` without
holding `*`**. A Manager could invite an address they control as an Admin and
return through the front door with permissions nobody granted them.

The SSO gap needs a custom role carrying `ADMIN_SETTINGS` and less than
everything else — not the seeded set, but an ordinary thing for a tenant to
want.

Both now call the guard. The pattern is the same as finding 2: **a rule
applied to one of two paths that need it.**

### 7. A comma in a search term returned a 500

`.or()` is the one Supabase builder that takes a raw PostgREST filter
_string_, so an interpolated term is parsed as syntax rather than treated as a
value. `or=(name.ilike.*M6, 20mm*)` reads the comma as the separator between
two conditions, the remainder fails to parse, and PGRST100 surfaces as a 500.

Part descriptions routinely contain commas. Five call sites in
`/api/search`, plus `/api/parts` and `/api/parts/export`.

**Checked against the live database before assuming the worst**, because this
looks like injection: a `)` does _not_ escape the `or=(...)` group, and no
term reaches another tenant's rows — the tenant filter is a separate `.eq()`
that PostgREST ANDs with the group. Robustness, not isolation.

Fixed with `ilikeContains` in `src/lib/validation.ts`, which quotes and
escapes rather than stripping, so a term containing a comma still searches for
that term. `/api/releases` originally stripped `,()`; it now uses the helper
too, because the stripping version silently searched for something else.

---

## What this says about the codebase

Three patterns, each of which produced more than one finding:

**A deliberately-soft error path needs something that notices when it stops
being rare.** Finding 1 hid three hard schema faults for a day inside a
branch designed to absorb one specific user error. The fix is not to make it
throw — the original reasoning was sound — it is to log.

**A permission that is granted but never read is worse than no permission.**
Finding 2 looked enforced from `DEFAULT_ROLES`, from `PERMISSION_INFO`, and
from the tests. Now guarded by the `unenforced-permission` lint rule.

**Unresolved narration in shipped code is a defect marker.** Finding 4's
author wrote down that they had not solved the problem, in the function, and
it shipped.

**A rule applied to one of two paths is the most common shape here.** Findings
2 and 6 are both this: the guard existed, was correct, and covered one caller.
When you add a guard, grep for every route that does the same _act_, not the
same _thing_.

It has since happened twice more, which promotes it from a pattern to the
thing to check first. Self-approval needed the same guard on the approval
engine _and_ the direct ECO path (item 4). And the revision fix reached one of
**three** copies of the same reopen — see item 6. In every case the fix was
written at the call site the bug was found in, and no one looked for the
others. Neither the tests nor the linters can see this: each path is
individually correct-looking, and the one that was fixed proves the rule
exists.

---

## Guards added

| Guard                             | Catches                                                                 |
| --------------------------------- | ----------------------------------------------------------------------- |
| `npm run probe:schema`            | columns, NOT NULL, tables and RPCs that disagree with the live database |
| `unchecked-delete` lint rule      | a discarded `delete()` result — finding 5's shape                       |
| `unchecked-insert` lint rule      | a discarded `insert()` result — the QuickBooks vendor bug's shape       |
| `unchecked-update` lint rule      | a discarded `update()` result — the row silently keeps its old value    |
| `unenforced-permission` lint rule | a permission granted and described but never read — finding 2's shape   |
| `status-flows.test.ts`            | the SQL and TypeScript copies of the ECO-release rule drifting          |

`probe:schema` deliberately never writes. An intermediate version confirmed
findings by posting a row that omitted the column under test, assuming a
bogus foreign key would always reject it — true for child tables, false for
root ones. It inserted a junk row into the production `tenants` table, which
was caught by a guard and removed. **A read-only audit that can write under
some inputs is not read-only.**

---

## What is left

### ~~1. Burn down `unchecked-delete` — 20 sites~~ Done 2026-08-06

All 20 now bind `{ error }` and refuse before the audit row: a 409 carrying
the database's own message on the unwrapped routes, `conflict(...)` on the two
that are already on `withTenant`.

The original note said most were on CASCADE tables or pre-checked. Reading
them, four had a real gap the pre-check could not cover, and they are the ones
worth remembering:

- **`lifecycle/[lifecycleId]/states`** checks that no _file_ sits in the state,
  but a transition referencing it also pins it. Nothing else would have caught
  that.
- **`lifecycle/[lifecycleId]`** deletes transitions, states and the lifecycle
  in sequence. A failure partway used to report success, leaving a lifecycle
  with no states — which renders as an empty dropdown rather than as an error.
- **`workflows/[workflowId]` archive** drops the assignments so the workflow
  stops firing. Discarding that error reported "archived" while it went on
  triggering on every transition.
- **`workflows/[workflowId]/steps`** re-orders the remaining steps immediately
  after the delete, so a failed delete meant re-ordering around a step that was
  still there.

The lint rule stays; the ratchet is what stops the next one.

### ~~2. Turn the dead-permission scan into a lint rule~~ Done 2026-08-06

`unenforced-permission` in `scripts/lint-conventions.mjs`. It parses
`PERMISSIONS` and fails on any entry no server-side file reads, by constant or
by bare string value, reporting against the declaration line.

It could not be a per-file rule — a permission and its enforcement are never in
the same file — so it runs once over the whole scan.

Two things it deliberately does:

- **Server components count.** This is the trap the earlier scan fell into:
  classifying by directory reported `audit.view` as unenforced when its gate is
  a check in `audit-log/page.tsx` that runs before any query, with no endpoint
  to bypass. Verified by disabling that branch — `AUDIT_VIEW` immediately
  false-positives, so the branch is load-bearing rather than defensive.
- **Client components do not count.** `usePermissions().can(...)` hides
  buttons, which is an affordance and not a control. A permission enforced only
  there is precisely the hole this rule exists to find, so counting it would
  defeat the rule.

Currently zero violations. Verified it can fail by adding a throwaway
permission and watching it fire at the right line — a rule that cannot fail
proves nothing.

### 3. Audit what this pass did not reach

Covered: file lifecycle, ECO, BOM, approvals engine, folders/ACLs/trash,
SSO/JIT provisioning, and cron authentication.

`withCron` came through clean — constant-time bearer compare, and a missing
`CRON_SECRET` is a 401 rather than a skipped check. SSO/JIT itself is careful:
domains must be `status='active'`, the adoption path rewrites `authUserId` on
the existing row so history stays attached, and races resolve through
`ON CONFLICT`. Finding 6 is in the admin route that configures it, not the
provisioning.

Also covered, on a second pass: parts, vendors, search, metadata fields,
saved searches, and notification delivery. Finding 7 came out of search;
everything else there held up:

- **Metadata fields and vendors** — wrapped, gated on the permission their
  screen implies.
- **Saved searches** — tenant-scoped through the wrapper, and a shared search
  is visible tenant-wide but deletable only by its author.
- **Notification delivery** — `notify` filters the actor out so nobody is told
  about their own action, and the email path honours per-type opt-out and
  skips inactive users.
- **Part deletion** — refuses while the part is used in any BOM item, and
  `eco_items.partId` is RESTRICT behind that.
- **Plain `.ilike()` / `.eq()` calls** — the value is a separate argument that
  Supabase escapes, so only `.or()` ever needed this.

Nothing is now entirely unwalked, but the coverage is uneven: this pass read
routes and schema rather than exercising flows against real data. Anything
depending on volume, concurrency, or a populated vault is still unproven.

**This is the one item in this plan still open, and it is open by nature.**
Items 1, 2 and 4 are closed. This one cannot be finished by reading — it needs
flows exercised against a populated vault, which means it stays open until the
item master is imported and real BOMs are in use. Do not mark it done on the
strength of another code read.

Two findings since, both of which support the point that reading is not enough:

- **The BOM rollup ignored every cost in the parts library.** It read
  `bom_items.unitCost` and had no fallback to the part at all, so a priced part
  contributed zero to every total it appeared in. Found while adding
  `estimatedCost`, not by auditing — it looks entirely correct in the source.
  Fixed 2026-08-06.
- **The trash listing hid its own contents past 200 rows.** A flat cap with no
  paging, so the oldest deletions stayed in the database and vanished from the
  UI. Also invisible to a code read; it only shows up with volume. Fixed
  2026-08-06.

- **The QuickBooks importer never linked a single vendor.** It wrote
  `part_vendors.vendorName` and omitted `vendorId`, NOT NULL behind a RESTRICT
  FK since migration 009, so every insert was rejected with 23502 — and the
  result was never bound, so the row still counted as `updated`. Fixed
  2026-08-07; details in
  [`cad-erp-integration.md`](cad-erp-integration.md#sequencing).

Both of the first two are the shape this item is about: correct-looking code
whose defect only appears once there is data in it. **The third is a different
and more encouraging shape** — `npm run probe:schema`, the guard this plan
added, found it by name without anyone auditing anything. Two lessons carried
forward:

- **A discarded write result is the common factor across four findings now**
  (1, 5, the `unchecked-delete` burn-down, and this one). ~~An unbound
  `insert()` is the same defect and is not yet linted.~~ **`unchecked-insert`
  added and burned down 2026-08-07 — see [item 5](#5-burn-down-unchecked-insert--23-sites-done-2026-08-07).**
- **A mock that accepts any object turns a test into decoration.** The test
  asserting the vendor link was written against the shape the code produced,
  not the shape the database requires, so it passed for as long as the bug
  existed. Its mock now enforces the NOT NULL columns.

### ~~5. Burn down `unchecked-insert` — 23 sites~~ Done 2026-08-07

The sibling of `unchecked-delete`, added after the QuickBooks importer turned
out to have never linked a vendor. Same ratchet, same rule shape. All 23 sites
now bind the result — but **not all the same way**, and the split is the part
worth keeping:

**Refuse the request** where the missing row makes what follows wrong.

- **`file_versions` × 4** (`files`, `checkin`, `upload-version`, `restore`).
  Each inserted the version row and then bumped `files.currentVersion`, which
  is what every read resolves the current blob through. A discarded failure
  aimed the vault at a version row that was never written. All four now stop
  before the bump, which leaves the file whole and the upload retryable. The
  initial-upload case additionally deletes the file row it had already
  committed, since a file at `currentVersion: 1` with no version row shows in
  the vault and can never be opened.
- **`approval_decisions`** in `startWorkflow`. A request with fewer decision
  rows than the step has seats can never satisfy ALL or MAJORITY — which is
  finding 4, arrived at from a different direction. Now returns
  `{ success: false }` naming the seat, and a test pins it.
- **`metadata_values`**. Reported `{ success: true }` over a value the user
  watches vanish on their next refresh. Now collects every field that failed
  and names them, rather than abandoning the loop at the first.
- **Tenant creation × 12.** The whole signup sequence. Each step feeds the
  next — the Admin references a role, the transitions reference the states,
  the assignment references the group and the workflow — so a discarded
  failure produced a workspace that looked created and was not. They run
  through a local `setupStep` helper that names the step in its message, and
  a failure now **deletes the tenant row**, which cascades the partial
  workspace away and frees the slug so the caller can retry. Without that,
  signup failing halfway left someone outside a workspace that half existed.

**Log and carry on** where the row records something that already happened, so
throwing would fail a request that succeeded.

- `logAudit`, `notify`, `addHistory`, mentions, share-token access. This is
  finding 1's lesson applied: the fix for a deliberately-soft path is not to
  make it throw, it is to make it noticeable.
- `notify` additionally skips its email loop when the rows did not land —
  `sendNotificationEmail` writes back onto a notification row that would not
  exist.

One of these was worse than a plain discarded result. **`logShareAccess`
already had a try/catch that logged**, and it had never once fired: PostgREST
_returns_ a rejected write rather than throwing, so a refused insert walked
straight past the handler. An error path that cannot be reached reads as
coverage, which is how it survived review.

Verified the rule can fail by adding a throwaway unchecked insert and watching
it fire at the right line.

### ~~6. Burn down `unchecked-update` — 49 sites~~ Done 2026-08-07

The third and last of the set. Same rule shape, and by far the biggest — 49
sites across 28 files, more than `delete` and `insert` combined.

It is also the quietest of the three. A rejected delete leaves data that
should be gone; a rejected insert leaves a gap. A rejected **update** leaves a
row that already existed and still reads perfectly well — the only symptom is
that it holds the value it held before. Nothing is missing, so nothing looks
wrong.

Four shapes came out of it:

- **The approval engine, 13 sites.** The largest cluster and the worst
  consequences: a request that reports approved and stays PENDING, a next step
  reported active while every seat on it is still WAITING and nobody can act,
  a recall that leaves its approvals open. They run through a local `applied`
  helper that names what did not happen. The two writes that actually move
  the entity — the file transition and the ECO status, both in
  `handleRequestCompletion` — are a deliberate exception: they return a
  **warning** rather than an error, because by then the approval genuinely is
  complete and telling the approver it failed would be false. What failed is
  the effect, and an approved request whose file never moved looks identical
  to one that did.
- **Exclusive-flag clears, 6 sites** (default lifecycle ×2, initial state ×2,
  primary vendor, primary file). All of the form "unset the other one, then
  set this one". No constraint enforces any of these, so a discarded failure
  leaves two defaults and the winner depends on row order.
- **State transitions**, in `files/[fileId]/transition`, `bulk-transition`,
  `ecos/[ecoId]`, and the checkout releases in `users/[userId]`. All now
  refuse before the audit row, which is finding 5's lesson on the update side:
  a false audit entry is worse than the failed write.
- **Log-like write-backs** (email delivery status, notification read flags,
  share access counts) — logged, never fatal.

One left deliberately unbound, with an allow-comment: the last-resort
`thumbnailAttemptedAt` stamp inside the handler for the failure it is
reacting to. A second warning there would say nothing the first did not.

**This burn-down found a live bug, which is the argument for doing it by hand
rather than mechanically.** See below.

## The revision fix had reached one of three paths

`src/lib/revision.ts` exists because `String.fromCharCode(rev.charCodeAt(0) + 1)`
corrupted rather than failed — Z became `[`, R2 became `S`, written straight
into the field a release is identified by. [`change-control.md`](change-control.md)
records that as fixed.

It was fixed in `POST /api/files/[fileId]/transition`. Reading the update
sites turned up **two more copies still running the old arithmetic**:

- `approval-engine.ts` — the same reopen, when the transition requires
  approval. So a released file reopened directly got the right revision and
  one reopened through a workflow did not.
- `files/bulk-transition` — the same reopen, in bulk.

Both now use `nextRevision`. They cannot refuse identically: the route returns
409 and stops, the bulk loop skips that file with a per-file reason, and the
approval path has nothing left to decline — the approval already happened — so
it thaws the file, leaves the revision alone, and returns a warning naming it.

This is the plan's own headline pattern for the fourth time: **a rule applied
to one of the paths that need it** (findings 2 and 6, self-approval, and now
this). The existing test covered A → B, which both the old and new code get
right, so it never fired. The new tests use R2 and Z.

### ~~4. Self-approval is still permitted~~ Settled and built 2026-08-06

Permitted by default, with a tenant setting (`blockSelfApproval`) an admin can
turn on under Admin → Settings → Change Control. Reasoning in
[`../decisions/self-approval.md`](../decisions/self-approval.md).

Enforced in [`src/lib/self-approval.ts`](../../src/lib/self-approval.ts), called
from **both** decision paths — the approval engine and the direct ECO status
update. The second is the one that matters: no tenant is seeded with an ECO
workflow, so `findWorkflowForTrigger` falls through and almost every ECO is
decided without the engine ever running. Gating only the engine would have left
the setting looking enforced and doing nothing, which is this plan's finding 2
happening a second time.

---

## Related

- [`change-control.md`](change-control.md) — findings 1–3 land on its item 1
- [`codebase-hardening.md`](codebase-hardening.md) — the ratchet these guards join
- [`../decisions/hand-applied-migrations.md`](../decisions/hand-applied-migrations.md) — why auditing against the database rather than the migration files is the only reading that counts
