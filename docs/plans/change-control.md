# Change control — what the workflow review found, and what is left

**Started:** 2026-08-05 · **Last updated:** 2026-08-05 · **Status:** in progress

<!-- plan-metrics
bom-revise-route: 1
eco-implements-boms: 0
-->

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
Fixed by `eco_items.bomId` (migration 046), end to end including the picker.

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

### 1. `implement_eco` does not act on BOM items — the top item

An ECO can now **record** that a BOM goes from revision B to C. Implementing
that ECO does nothing about it: the Postgres function bumps part revisions
and freezes files, and skips `eco_items` rows carrying a `bomId` entirely.
So the loop is only three-quarters closed — the change order describes the
BOM change and a human still has to go and make it.

Two ways to close it, and the choice matters:

- **Call the revise logic from `implement_eco`.** Atomic with the rest of
  the implementation, which is the appeal. But the revise rules currently
  live in a route handler, and duplicating them into PL/pgSQL is exactly
  the drift `status-flows.ts` exists to prevent.
- **Have the route orchestrate**: implement the ECO, then revise each BOM
  item. Rules stay in one place, but it is no longer one transaction, and a
  half-implemented ECO is the state migration 011 went out of its way to
  make impossible.

Leaning toward the first with the shared rules pushed down into SQL, but it
wants a decision doc rather than a preference. Until then, note that
`toRevision` on a BOM item is documentation, not an instruction.

### 2. No revision history in the UI

A superseded revision is filtered out of `GET /api/boms` (correctly — it is
not what you are working on) and there is no way to reach it except by URL.
`previousRevisionId` and `supersededById` make the chain walkable; nothing
walks it.

Wants: a "Revision history" section on the BOM detail listing the chain with
dates and the ECO that caused each step, and a badge on a superseded
revision saying what replaced it.

### 3. Effectivity is stored but never read

The columns are typed, indexed and editable, and nothing queries them. The
questions that justified the work are still unanswered:

- "What is in effect on 1 March?" — needs a date-filtered view of implemented ECOs
- "Which BOM shipped on unit 47?" — needs serial effectivity resolved against release history

Neither is hard now that the data is typed. Both were impossible before.

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

- **No serial or as-built tracking.** Serial _effectivity_ exists; recording
  what actually shipped on a given unit does not. Required for regulated or
  serial-tracked manufacturing, ignorable otherwise. Segment decision.
- **BOM revision is free text on the PUT route.** `revise` sequences it
  properly, but `PUT /api/boms/[bomId]` still accepts any string, so a BOM
  can be dragged to a revision the sequencer would never produce.
- **`usesReservedLetter` is unused.** It exists to warn on imported data
  using letters ASME reserves (`S`, `Z`). Nothing calls it; the parts
  importer is the obvious caller.

---

## Viability, as assessed

For PACE internally: the workflow is sound now that item 1 of the review is
fixed. Commercially, gaps 1–3 above were table stakes and are done; what is
left in this plan is depth rather than blockers.

The honest limit remains unchanged and is not in scope to fix: this is not a
CAD-native vault. There is no add-in, no reference parsing, and no file
locking on disk. Sell it against Arena and Duro, not against SolidWorks PDM.

---

## Related

- [`../decisions/bom-structure.md`](../decisions/bom-structure.md) — structure derived, designation declared
- [`cad-erp-integration.md`](cad-erp-integration.md) — `isEndItem` and effectivity both map onto NetSuite fields
- [`codebase-hardening.md`](codebase-hardening.md) — the operational items (dev database, verified backups) still gate all of this
