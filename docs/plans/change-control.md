# Change control — what the workflow review found, and what is left

**Started:** 2026-08-05 · **Last updated:** 2026-08-06 · **Status:** in progress — one item left (effectivity is stored and nothing reads it)

<!-- plan-metrics
bom-revise-route: 1
eco-implements-boms: 1-->

A review of the four core PDM workflows — file lifecycle, change orders,
BOM lifecycle, and impact analysis — walked end to end against the code on
2026-08-05. It found one blocking gap and three real ones. All four are
fixed. This plan exists because the fixes opened follow-ups that live
nowhere else, and because the reasoning behind two deliberate omissions
would otherwise read as oversights to whoever comes next.

**Read [`../decisions/bom-structure.md`](../decisions/bom-structure.md)
first.** It carries the model this plan assumes: structure is derived,
designation is declared.

---

## What the review found, and what shipped

**1. A released BOM could never be revised.** The blocking one.
`BOM_STATUS_FLOW` allowed `RELEASED → OBSOLETE` and nothing after it, and
the items route refused edits on both — so releasing a BOM made it
permanently unchangeable. Files had revise-on-reopen all along, so this was
an omission rather than a position.

Fixed by [`POST /api/boms/[bomId]/revise`](../../src/app/api/boms/[bomId]/revise/route.ts),
which creates the next revision as a **new row** in DRAFT with the structure
copied and `previousRevisionId` pointing back. The old revision is
superseded when the new one is _released_, not when it is drafted.

**2. An ECO could not contain a BOM.** `eco_items` had `fileId` and
`partId`, so a change order could govern a part revision but not the BOM
revision that went with it — which is most of what a change order is for.
Migration 046 added `eco_items.bomId` and the picker.

~~Fixed end to end.~~ **It was not.** Migration 046 left migration 017's
two-column CHECK in place, so every BOM-on-ECO insert was rejected by the
database, and `implement_eco` ignored BOM rows even in principle. Both closed
by migration 049 on 2026-08-05 — see [item 1](#1-implement_eco-does-not-act-on-bom-items-closed-2026-08-05).
The claim above stood in this plan for a day while the feature did not work,
which is the argument for the plan-metrics linter covering behaviour and not
just counts.

**3. Revision sequencing corrupted data silently.**
`String.fromCharCode(rev.charCodeAt(0) + 1)` turned `Z` into `[` and `R2`
into `S`, writing a wrong value into the field a release is identified by
rather than failing. Fixed by [`src/lib/revision.ts`](../../src/lib/revision.ts),
which follows ASME Y14.35 and refuses rather than guessing.

**4. Effectivity was free text.** "What is in effect on 1 March" and "which
BOM shipped on unit 47" were both unanswerable. Fixed by typed
`effectivityType` / `effectiveFrom` / `effectiveSerial`, with the prose
field kept for notes.

---

## What is left

### ~~1. `implement_eco` does not act on BOM items~~ Closed 2026-08-05

**Both halves of this were broken, and the second one was worse.**

**The framing above was wrong, and the correction is the useful part.** It
weighed "call the revise logic from `implement_eco`" against "have the route
orchestrate", both of which assume implementation has to _create_ the
revision. It does not. `POST /api/boms/[bomId]/revise` already takes an
`ecoId` and runs at ECO **authoring** time, so revision C exists as a DRAFT
and is linked to the ECO before anyone approves it. What implementation owes
is a **release**, not a revise:

1. the carried BOM → `RELEASED`
2. its `previousRevisionId` → `OBSOLETE`, `supersededById` → the new row

That is small enough to live in PL/pgSQL without duplicating the revise
rules, so the dilemma dissolves. Done in
[`migration-049`](../../supabase/migrations/migration-049-implement-eco-boms.sql).

**`eco_items.bomId` never worked at all.** Migration 046 added the column,
the FK, the index, the unique key, the picker and the revise-route link — and
left migration 017's `CHECK (("partId" IS NULL) <> ("fileId" IS NULL))` in
place. A BOM-only row has both NULL, so the check evaluates `TRUE <> TRUE` =
`FALSE` and Postgres rejects the insert with 23514. Every BOM ever added to
an ECO was refused by the database.

It hid because the revise route deliberately downgrades an ECO-link failure
to a `warning` in the response body rather than throwing, so a hard schema
rejection read as a soft note. Migration 049 replaces the constraint with an
exactly-one-of-three check named `eco_items_target_one`.

**Verify this one against the live database before trusting it.** The
migration files are not a ledger, and this is precisely the class of drift
[`../decisions/hand-applied-migrations.md`](../decisions/hand-applied-migrations.md)
exists for.

Two smaller things came with it:

- **`createReleaseFromEco` never saw ECO-carried BOMs either.** It found BOMs
  by walking `boms.fileId` into the affected file set, so the BOM revision a
  change order existed to ship was absent from its own release manifest. Now
  unioned by id with the direct `eco_items.bomId` set.
- **Releasing from DRAFT crosses `BOM_STATUS_FLOW`**, which allows only
  `APPROVED → RELEASED`. Deliberate: the ECO's approval is the review, and a
  second independent approval cycle is ceremony. Recorded as
  `BOM_STATES_RELEASABLE_BY_ECO` in
  [`status-flows.ts`](../../src/lib/status-flows.ts) and pinned against the
  migration text by `status-flows.test.ts`, so the two copies cannot drift.

### ~~2. No revision history in the UI~~ Shipped 2026-08-05

`GET /api/boms/[bomId]/revisions` walks the lineage in both directions and
returns the whole chain, so one response serves "what came before this" on a
current revision and "what replaced this" on a superseded one. Rendered as a
**Revision history** panel on the BOM detail, with the governing ECO on each
step, and a banner on a superseded revision linking to its replacement.

Three things worth knowing before touching it:

- **A superseded revision is not in `GET /api/boms`**, so the detail view
  could not resolve one — it showed "This BOM no longer exists." The panel
  would have linked exclusively to dead ends. `boms-view` now falls back to
  the detail endpoint, which does not filter on `supersededById`, whenever
  the selected id is absent from the list.
- **Order comes from the links, not from `createdAt`.** Sorting by timestamp
  ordered revisions arbitrarily when they shared a millisecond, which a bulk
  import produces. The walk order is the ordering; a test pins it with every
  `createdAt` identical.
- **Both walks need a cycle guard.** This endpoint runs every time anyone
  opens a BOM, so a corrupt `previousRevisionId` loop would spin against the
  database on an ordinary page view. Guarded by a `seen` set, not just by the
  iteration cap.

### 3. Effectivity is stored but never read — **re-scoped 2026-08-06, and it shrank**

The columns are typed, indexed and editable, and nothing queries them. The
original framing of this item was "add the two queries that were impossible
before". **That framing was wrong**, and correcting it is most of the value
here.

**Two of four effectivity types cannot be computed by this app, ever.**

| Effectivity   | Can PACE answer "is it in effect?"                    |
| ------------- | ----------------------------------------------------- |
| Immediate     | **Yes** — from the implementation date                |
| From a date   | **Yes**                                               |
| From a serial | **No** — needs the unit's serial, which is in the ERP |
| On use-up     | **No** — needs inventory levels, which are in the ERP |

`SERIAL` was in the original list as "resolve serial effectivity against release
history". It cannot be resolved here at all: PACE does not know serials.

Worse, the common case in equipment manufacture is missing from the enum
entirely. **A change usually takes effect when existing stock of the old design
is used up** — not on a date, not at a serial. Production keeps building the old
one until the shelf is empty. That is an inventory fact, so the app cannot
compute it either, and today there is no honest way to record it: the options
are Immediate, a date, or a serial, so anyone with a use-up change picks a
fictional date or leaves it blank.

**So the work is:**

1. **Add `USE_UP` to `EffectivityType`.** One enum value, one label, a CHECK
   constraint update. It makes the field record something true, which it
   currently cannot for the most common case.
2. **Answer only what is answerable.** For `IMMEDIATE` and `DATE`, resolve which
   revision was in effect on a given date. For `SERIAL` and `USE_UP`, display
   the recorded intent and say where the answer lives — _"from serial N1S-0470 —
   check the unit in your ERP"_. **Do not calculate.** A query that looks right
   and is wrong in practice is worse than no query.
3. **Do not remove `DATE` or `SERIAL`.** PACE mostly will not use them, but this
   is a multi-tenant product: serial effectivity is standard in aerospace and
   medical devices, and date cutoffs are normal wherever a regulation or a
   supplier contract sets one. Removing an option because one tenant does not
   use it is the mistake
   [`../decisions/erp-ownership.md`](../decisions/erp-ownership.md) was rewritten
   to prevent.

**Related, undocumented, and worth deciding separately:** `implement_eco` does
not read effectivity at all. Implementing an ECO releases the carried revision
immediately, whatever the ECO says about when it takes effect. That is
defensible — releasing a design is not the same as switching production — but
nothing says so, and `RELEASED` therefore does not mean "being built".

Do **not** confuse any of this with as-built genealogy ("which physical bracket
is in unit 47"), which lives in the ERP work order and is deliberately not built
here. The two get conflated constantly; the split is in
[`../decisions/erp-ownership.md`](../decisions/erp-ownership.md).

### 4. Deliberate omissions — do not "fix" these without a decision

**Parents are not repointed when a child is revised.** A parent BOM citing
revision A goes on citing revision A after A is superseded, because that is
what the parent's own release said. Moving a parent onto a new child
revision _changes the parent_, and therefore wants its own ECO. This looks
like a bug in the tree — a released machine showing an old sub-assembly
revision — and it is not.

**Revising does not supersede immediately.** Until B is released, A is still
the revision in effect, so `supersededById` is set on release rather than on
draft. A draft supersedes nothing.

### 5. Smaller things the review surfaced

- **~~No serial or as-built tracking.~~ Closed 2026-08-06 — half of it will not
  be built, and the other half is item 3 above.** Recording which _physical_
  components went into a serial belongs to the NetSuite work order; a copy here
  would be fed by hand and drift. But identifying **which version of the machine
  a customer received** is PACE's job, it is what revision lineage plus
  effectivity is for, and it is not done — see item 3. The two are routinely
  confused; the split, and the caveat about component-level genealogy needing
  serialised inventory on the components rather than just the finished machine,
  are in [`../decisions/erp-ownership.md`](../decisions/erp-ownership.md).
- **~~BOM revision is free text on the PUT route.~~ Closed 2026-08-06.**
  `PUT /api/boms/[bomId]` now refuses a revision `nextRevision` cannot
  continue from, and refuses reserved letters outright. It deliberately still
  allows a manual correction — fixing a typo, or matching what the ERP already
  calls this revision — because what causes harm is a value with no successor,
  not a value that was typed rather than sequenced. Without this the _next_
  revise fails, on a released BOM, with no obvious connection to the edit.
- **~~`usesReservedLetter` is unused.~~ Closed 2026-08-06.** Called by
  `POST /api/parts/import`, which now returns a per-row `warning` alongside
  `error` and a `warned` count, surfaced in the import results dialog. Warned
  rather than rejected on purpose: a part at revision `S` is a fact about
  QuickBooks, not a mistake the importer gets to refuse. The warning is what
  tells the importer's user why revising that part will later ask for the next
  revision by hand.

  Note the distinction the response now draws: `error` means the row did not
  land, `warning` means it did. Folding warnings into `failed` would make the
  summary read "2 rows did not import" when all of them did — pinned by a test.

---

## Viability, as assessed

For PACE internally: the workflow is sound now that item 1 of the review is
fixed, and closed end to end since 2026-08-05 — an approved ECO now releases
the BOM revision it carries instead of leaving a human to do it. Commercially,
gaps 1–3 above were table stakes and are done; what is left in this plan is
depth rather than blockers.

One lesson worth carrying out of the `eco_items.bomId` bug: a feature can be
complete in the schema, the API, the UI and the plan, and still be rejected
by a CHECK constraint on every call. The tell was there — the revise route's
graceful `warning` path fired every single time — and nobody read it as a
failure because it was designed to look survivable. **When an error path is
deliberately soft, something has to notice when it stops being rare.**

The honest limit remains unchanged and is not in scope to fix: this is not a
CAD-native vault. There is no add-in, no reference parsing, and no file
locking on disk. Sell it against Arena and Duro, not against SolidWorks PDM.

---

## Related

- [`../decisions/bom-structure.md`](../decisions/bom-structure.md) — structure derived, designation declared
- [`cad-erp-integration.md`](cad-erp-integration.md) — `isEndItem` and effectivity both map onto NetSuite fields
- [`codebase-hardening.md`](codebase-hardening.md) — the operational items (dev database, verified backups) still gate all of this
