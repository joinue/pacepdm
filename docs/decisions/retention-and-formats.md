# Nothing is destroyed on a timer, and neutral formats are prompted rather than required

**Status:** active
**Decided:** 2026-08-06
**Applies to:** the trash (`files.deletedAt`), `/api/files/deleted`, the upload dialog, the CAD viewer

Three retention-and-format questions that had been sitting open long enough to
keep resurfacing as "gaps". They are answered here so they stop being rediscovered.

## 1. The trash never empties itself

A deleted file is soft-deleted: the row stays and the storage blob stays.
**Nothing purges either, and nothing ever will on a schedule.**

Permanent deletion is a deliberate act: an admin-only action on a specific file
in the trash, one at a time.

`DELETE /api/files/[fileId]/purge`, gated on `FILE_PURGE` — a permission
deliberately absent from `DEFAULT_ROLES`, so Admin holds it through `"*"` and
Manager, who can move files to the trash, does not.

Storage blobs are removed before any row. Rows-first would orphan the blobs
with nothing pointing at them: unrecoverable _and_ invisible. Failing this way
round leaves the file in the trash, whole and retryable. A live file cannot be
purged at all — only rows with `deletedAt` set resolve — so destruction is
always two separate decisions.

The audit row survives the file. It is append-only and this route never touches
it, so what existed and who destroyed it outlives the deletion. A permanent
delete that erased its own evidence would be worse than none.

**Why not a 90-day auto-purge**, which is the obvious default and was rejected:
this is the BOM of record. The whole reason the trash exists is that recovering
a file used to need database access. A timer that quietly destroys evidence is
the same failure in slower motion — and the window is always wrong, because
nobody discovers they needed a file on a schedule.

**The cost, accepted:** storage grows monotonically, and the bill grows with it.
That is a bill for keeping things, which is the correct thing to be paying for
here. Revisit if it ever becomes a real number rather than a theoretical one.

**The listing cap was the actual bug, and is fixed.** The trash listing was
capped at a flat 200 rows, so past 200 deletions the oldest ones stopped
appearing in the UI while remaining perfectly present in the database —
invisible, undeletable, and un-restorable through any supported route. A cap
that hides data is worse than no cap, because it looks like the data is gone.

Now offset paging with an exact total, so the UI can say "1–100 of 3,412"
rather than implying 200 is all there is. Offset rather than cursor
deliberately: a bulk delete stamps every file in the batch with the same
`deletedAt`, so a cursor on that column alone skips rows at a page boundary,
and a compound cursor would mean building an `.or()` filter from a
client-supplied string — the one Supabase builder that parses its argument as
syntax rather than escaping it. `hasMore` is computed from the pre-ACL count,
so a page emptied entirely by folder permissions does not read as the end of
the list.

## 2. Neutral-format exports are prompted, never required

`.SLDPRT` / `.SLDASM` / `.SLDDRW` are proprietary OLE binaries. They **can never
render in 3D in a browser** — occt-import-js is OpenCascade and reads neutral
formats only (`step`, `stp`, `iges`, `igs`, `stl`, `obj`). All that can be
extracted from a native SolidWorks file is the embedded 2D preview bitmap.

So a vault of SolidWorks files is a vault nobody can look inside, and no amount
of viewer work changes that.

Uploading a SolidWorks file with no neutral-format sibling therefore **prompts**
— a non-blocking nudge saying the file will be 2D-preview-only, and why.

`needsNeutralExport` in [`vault-types.ts`](../../src/components/vault/vault-types.ts)
decides, and the upload dialog renders the notice when it returns true.

The check is on the extension of the selected file, not on whether a sibling
export already exists — the upload dialog takes one file at a time and does not
hold a listing of the folder, so there is nothing to compare against without an
extra round trip on every keystroke. The cost is that someone uploading the
STEP second sees the notice on the first file. That is the right way round to be
wrong: a redundant nudge is ignorable, a missing one leaves a file nobody can
open.

**Why not enforce it**, refusing check-in without a STEP export: the friction
lands on the person mid-task, and the first time somebody is in a hurry they
will find a way around it — attaching a stale STEP is worse than attaching
none, because it looks current. A prompt gets the habit started while the vault
is small, which is the entire value: retrofitting exports onto 500 files is
manual labour, doing it from file #7 is free.

**The cost, accepted:** some files will have no 3D preview, including on
supplier share links. That is visible in the UI rather than silent.

## 3. Production is the development database, deliberately

`.env.local` points at the live Supabase project. `npm run dev` edits real data.

This is a **known, accepted risk** while PACE and Joinue are the only tenants —
Joinue functions as the test environment. It is not an oversight, and it should
not be re-raised as a finding.

**What it does not excuse.** There is no second copy of the BOM of record
anywhere. Working directly on production makes verified backups matter more, not
less, and an untested restore is not a backup. That remains open and is the one
operational item that has never been closed.

**What reopens this:** a third tenant. At that point another customer's data is
in reach of a dev session, and "Joinue is the test environment" stops being true.

## Related

- [`../plans/codebase-hardening.md`](../plans/codebase-hardening.md) — where the trash and the dev-database items came from
- [`../plans/cad-erp-integration.md`](../plans/cad-erp-integration.md) — the SolidWorks seam this constrains
- [`supplier-access.md`](supplier-access.md) — why a share link showing no 3D preview still has to be honest about what it is showing
