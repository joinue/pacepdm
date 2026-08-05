# Functional audit — what was broken, and what it says about the codebase

**Started:** 2026-08-05 · **Last updated:** 2026-08-05 · **Status:** phase 1 complete

<!-- plan-metrics
unchecked-delete: 20-->

A workflow-by-workflow audit against the **live database**, not against the
migration files or the tests. Prompted by `eco_items.bomId`: the column, the
FK, the index, the picker and the API all existed and agreed with each other,
and every insert had still been rejected for a day by a CHECK constraint
nobody re-read.

Five findings across five workflows. Every one was invisible to
`npm run check`.

**Read this before adding features.** Four of the five were governance or
correctness holes in the change-control story — the thing this product is for.

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

---

## What this says about the codebase

Three patterns, each of which produced more than one finding:

**A deliberately-soft error path needs something that notices when it stops
being rare.** Finding 1 hid three hard schema faults for a day inside a
branch designed to absorb one specific user error. The fix is not to make it
throw — the original reasoning was sound — it is to log.

**A permission that is granted but never read is worse than no permission.**
Finding 2 looked enforced from `DEFAULT_ROLES`, from `PERMISSION_INFO`, and
from the tests. `scripts/` now has no guard for this; the scan that found it
is worth turning into one.

**Unresolved narration in shipped code is a defect marker.** Finding 4's
author wrote down that they had not solved the problem, in the function, and
it shipped.

---

## Guards added

| Guard                        | Catches                                                                 |
| ---------------------------- | ----------------------------------------------------------------------- |
| `npm run probe:schema`       | columns, NOT NULL, tables and RPCs that disagree with the live database |
| `unchecked-delete` lint rule | a discarded `delete()` result — finding 5's shape                       |
| `status-flows.test.ts`       | the SQL and TypeScript copies of the ECO-release rule drifting          |

`probe:schema` deliberately never writes. An intermediate version confirmed
findings by posting a row that omitted the column under test, assuming a
bogus foreign key would always reject it — true for child tables, false for
root ones. It inserted a junk row into the production `tenants` table, which
was caught by a guard and removed. **A read-only audit that can write under
some inputs is not read-only.**

---

## What is left

### 1. Burn down `unchecked-delete` — 20 sites

Baselined, so the ratchet stops new ones. Most are on CASCADE tables or are
pre-checked, which is why only the folder one had a live consequence — but
each needs the two-line check before its audit row can be trusted.

```bash
node scripts/lint-conventions.mjs --list unchecked-delete
```

### 2. Turn the dead-permission scan into a lint rule

The scan that found finding 2 is a throwaway script. A permission with zero
server-side references should fail the build. Note the trap that produced a
false positive first time: **a server component is server-side.** Classifying
by directory reported `audit.view` as unenforced when its gate is a
`page.tsx` check that runs before any query, with no endpoint to bypass.

### 3. Audit what this pass did not reach

Covered: file lifecycle, ECO, BOM, approvals engine, folders/ACLs/trash.

Not covered: parts and vendors beyond their schema, the search page, metadata
fields, saved searches, SSO/JIT provisioning, the cron reminder job, and
notification delivery. The first four are lower stakes; **SSO and cron are
not** — both run without a browser session, and neither has been exercised.

### 4. Self-approval is still permitted

Nothing stops an approver approving an ECO they authored. Left as a policy
decision rather than imposed: with two Admins there is cover, and blocking it
could deadlock a small team. Worth settling deliberately.

---

## Related

- [`change-control.md`](change-control.md) — findings 1–3 land on its item 1
- [`codebase-hardening.md`](codebase-hardening.md) — the ratchet these guards join
- [`../decisions/hand-applied-migrations.md`](../decisions/hand-applied-migrations.md) — why auditing against the database rather than the migration files is the only reading that counts
