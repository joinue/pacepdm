# Functional audit — what was broken, and what it says about the codebase

**Started:** 2026-08-05 · **Last updated:** 2026-08-05 · **Status:** phase 1 complete

<!-- plan-metrics
unchecked-delete: 0-->

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

---

## Guards added

| Guard                             | Catches                                                                 |
| --------------------------------- | ----------------------------------------------------------------------- |
| `npm run probe:schema`            | columns, NOT NULL, tables and RPCs that disagree with the live database |
| `unchecked-delete` lint rule      | a discarded `delete()` result — finding 5's shape                       |
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

### 4. Self-approval — settled 2026-08-06, needs building

**Decided:** permitted by default, with a tenant setting (`blockSelfApproval`)
an admin can turn on. Reasoning in
[`../decisions/self-approval.md`](../decisions/self-approval.md) — briefly, a
hard block deadlocks a team this size and gets worked around by asking a
colleague to click approve on something they have not read, which is worse.

**What is left is the implementation**, not the decision:

- Add `blockSelfApproval` to the settings allowlist in `/api/settings` and to
  the admin settings screen.
- Enforce in `processDecision` and `rejectForRework` (decider vs
  `request.requestedById`) **and** on the direct ECO status path, which bypasses
  the approval engine entirely when no workflow is assigned. That second path is
  the one finding 2 was about — a rule applied to one of two paths that need it
  is the most common defect shape in this codebase.
- The refusal must name the setting, or it reads as a bug to whoever hits it.

---

## Related

- [`change-control.md`](change-control.md) — findings 1–3 land on its item 1
- [`codebase-hardening.md`](codebase-hardening.md) — the ratchet these guards join
- [`../decisions/hand-applied-migrations.md`](../decisions/hand-applied-migrations.md) — why auditing against the database rather than the migration files is the only reading that counts
