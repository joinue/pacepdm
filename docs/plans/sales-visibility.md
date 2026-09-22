# Sales visibility — what engineering changed, and what we can promise

**Started:** 2026-09-22 · **Last updated:** 2026-09-22 · **Status:** lead times
built; the change log is designed and not built

<!-- plan-metrics
lead-time-routes: 2
-->

> These numbers are verified by `npm run lint:plans`, which recomputes them
> from the codebase and fails the build if this plan has drifted.

Two requests from sales, a week apart, with the same shape underneath: a fact
engineering knows, that sales needs, and no way to get it without asking
someone.

1. **Engineering changes things and sales hears about it late.** A design
   changes, quotes and literature do not, and the first anyone in sales knows
   is a customer question.
2. **Lead times live in a spreadsheet** (`PACE_Equipment_Lead_Time_Tracker_V1.xlsx`),
   which is out of date the moment it is emailed.

Neither is really a PDM gap — done properly, an implemented ECO already knows
what changed, and a lead time belongs to a part. Both are being built anyway,
deliberately: the part library is not complete, ECOs are not yet how this team
works day to day, and sales needs an answer now. The design keeps the shortcut
from becoming a second source of truth: a post can point at the record it is
about, and once releases carry the change themselves, "post to the change log"
becomes a checkbox on a release rather than a thing somebody remembers to do.

---

## 1. Equipment lead times — built 2026-09-22

Migration 057. The spreadsheet, as a table, with the columns that rot in a
shared file stamped by the app instead.

- **`equipment_lead_times`** — one row per model, seeded with the 33 machines
  from the sheet and its four-week baseline as `typicalLeadTime`.
  `currentLeadTime` is what sales quotes today, and starts blank, because on
  day one nobody has said.
- **The sheet's two weakest columns are gone.** "Updated date" and "Who
  updated this (persons name)" were typed by hand; the app stamps
  `updatedById` and `updatedAt` on every write.
- **`equipment_lead_time_changes`** keeps what a value was before each change,
  with who changed it. A spreadsheet overwrites, so "what did we tell them in
  July" had no answer. Shown per model in a side panel.
- **Stale values say so.** A lead time nobody has touched in
  `LEAD_TIME_STALE_DAYS` (30) is badged "confirm" rather than quoted as
  current, and one never set reads "Not set yet". The sheet had a `Confirm`
  option in its dropdown, which is the same instinct done by hand.
- **The buckets are the sheet's own dropdown**, unchanged, in
  `src/lib/lead-times.ts` — free text in the database with the route
  validating against the list, because a CHECK constraint would surface as a
  500 with nothing useful in it, and the list is a sales convention that will
  change.
- **Reading needs no permission beyond a session**; sales holds Viewer. Stating
  a lead time needs `leadtime.edit`, new in `PERMISSIONS`, given to Engineer
  and above, and backfilled in migration 057 onto every existing role that
  already holds `file.edit` or `eco.edit`.
- Not linked to `parts` yet. `partId` exists, nullable and unused: the page has
  to work before the part library is complete, which is the whole reason sales
  asked for a spreadsheet.

**Still worth doing:** nobody is notified when a lead time changes — sales has
to open the page. A weekly digest of what moved, or a notification on the
models someone follows, is the obvious next step and is not built.

## 2. The change log — designed, not built

A feed engineers post to when something changes that sales should know: plain
words, optionally a PDF, optionally pointing at the part, file, ECO or release
it is about.

What decides whether it works, in order:

1. **It pushes.** A post lands in the notification bell and a daily email
   digest. A feed sales has to remember to visit is the wall nobody reads, and
   six months in the complaint becomes "it was in the change log".
2. **Sales can acknowledge a post**, and engineering can see who has. That read
   receipt is the accountability both sides are missing today, and the reason
   this beats a group chat.
3. **A post is a notice, never an approval.** No status, no gate, nothing
   waiting on it. The moment a post can hold something up it becomes a second
   ECO, and the two records start disagreeing.
4. **Edits are marked, deletes are not silent.** People argue from this feed.
5. **Attachments live outside the vault** — snapshots of a PDF someone sent,
   not controlled documents. Keeping them in `files` would put uncontrolled
   copies in the library the ECO process depends on.

Open questions for the team before building: whether a post notifies all of
sales or a chosen audience, and whether sales can reply on a post or only
acknowledge it.

**Later, when ECOs are routine:** "post to the change log" becomes a checkbox
when a release is created, pre-filled from the ECO. The feed stays the same
table; what changes is who types the post.
