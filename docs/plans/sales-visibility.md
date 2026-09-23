# Sales visibility — what engineering changed, and what we can promise

**Started:** 2026-09-22 · **Last updated:** 2026-09-22 · **Status:** lead times and the
change log built; releases still come only from an implemented ECO

<!-- plan-metrics
lead-time-routes: 3
change-log-routes: 7-->

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
- **Typical is the baseline, current is what is quoted.** Both are set from
  the same dropdown on the list, and both were seeded at four weeks. Only
  current writes history and notifies: correcting a baseline should not email
  the team, and nothing is quoted from it.
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

**Notifications and live updates — added 2026-09-22, migration 058.**

- A change to the quoted lead time notifies everyone active in the workspace,
  in-app and by email, through the same `notify()` path everything else uses.
  A change to a note or a description says nothing: it is not news.
- `leadtime` is a notification and email type of its own (migration 058 widens
  the `notifications.type` CHECK from migration 028). That is what lets one
  person turn these emails off on their profile without also losing everything
  filed under `system`. Default on, because sales asked for them and an opt-in
  nobody finds is the spreadsheet again.
- The profile page's email preferences used to declare their own copy of the
  type list, so a type added on the server had no checkbox. Every consumer of
  the type list — the profile checkboxes and their copy, the email defaults,
  the `PATCH /api/profile/email-prefs` schema, the bell badge, the page tabs,
  the count buckets — now reads `src/lib/notification-types.ts`. The PATCH
  schema was the one that mattered: it enumerated the types by hand, Zod
  strips unknown keys, so unticking "Lead times" saved with a success toast
  and changed nothing. Adding a type is one entry there plus the CHECK
  constraint in a migration.
- The page subscribes to `equipment_lead_times` and refetches when someone
  else changes a row, with the usual echo guard so our own write does not cost
  a second fetch. Migration 058 adds the table to the `supabase_realtime`
  publication — without that, the subscription succeeds and silently never
  fires.

**Flagging, and two sales roles — added 2026-09-22, migration 059.**

- **Sales can ask, without being able to answer.** `leadtime.flag` marks a
  machine as needing a check, with an optional reason ("quoting Acme Friday"),
  and notifies everyone who holds `leadtime.edit` — found by reading the
  roles' permissions, never by role name (`docs/decisions/system-roles.md`).
  Setting the lead time clears the flag, because that is the answer; someone
  who can edit can also clear it by hand ("checked, still six weeks"). Sales
  cannot clear their own flag — an ask that the asker can tidy away is not an
  ask.
- **`leadtime.note`** writes the note beside a lead time without setting the
  lead time. The PUT route declares no permission of its own and checks per
  field, because what the write needs depends on which field it touches: the
  documented exception to declaring permissions in the wrapper.
- **The two roles are custom, in this workspace only.** Not in
  `DEFAULT_ROLES` — every other tenant would get "Sales" and "Sales Manager"
  whether or not they sell anything. Migration 059 seeds them as ordinary
  `isSystem = false` roles, so the Roles page can edit or delete them:
  Sales is `file.view` + `leadtime.flag`, Sales Manager adds `leadtime.note`.
  Read-only everywhere else, which is what `file.view` alone means. The
  migration targets the only tenant in the database and refuses to guess if
  there is more than one — but it refused with `RAISE NOTICE`, which the
  Supabase editor shows as a grey line under a green "Success", so with the
  E2E workspace also in the database 059 created nothing and looked fine.
  Migration 062 does the same seeding and raises an exception instead — which
  is how the second tenant came to light. Migration 063 then dropped the
  guessing altogether and seeds every tenant in this database: both belong to
  the same owner, and the roles are still absent from `DEFAULT_ROLES`, so no
  other deployment gets them. Two migrations were spent protecting against a
  problem nobody had. A migration that decides to do nothing has to stop the
  person running it — and one that asks the person to identify a row by hand
  should first ask whether it needs to.
- Flagged machines join the "needs attention" filter, above stale ones.

**Still worth doing:** everyone hears about every change. For this team that
is right — it is one page and a handful of changes a week — but if it turns
noisy, the next step is either a daily digest or letting people follow the
models they quote, rather than telling people to switch the emails off.

## 2. The change log — built 2026-09-22

Migration 060. A feed engineers post to, that sales reads.

- **`change_log_posts`** — plain words, a category (design, lead time,
  pricing, documentation, general) and optional links to the part, file, ECO
  or release it is about. A post carries no status and gates nothing: the
  moment it can hold something up it is a second ECO, and the two records
  start disagreeing.
- **It pushes.** Every post notifies everyone active, in-app and by email,
  under a `changelog` type people can mute on their own. A feed nobody is
  told about is the wall this replaces.
- **`change_log_reads`** — the read receipt, and the half a group chat cannot
  do: engineering sees a change landed, sales can show they were told. Marking
  a post read needs no permission; anyone signed in can.
- **Edits are marked, withdrawals are soft.** `editedAt` shows beside a post;
  withdrawing sets `deletedAt` and stops the feed showing it without
  destroying what was said. Only the author edits; an author or an admin
  withdraws.
- **`change_log_files`** — attachments in the vault bucket under a
  `change-log/` prefix, tracked in their own table, NOT in `files`. They are
  snapshots of what was sent, not controlled documents; in the library they
  could reach a release package, which is what the ECO process exists to
  prevent. PDFs, images, text, CSV, Excel (.xlsx/.xlsm/.xls), Word and
  PowerPoint, 25 MB each and five per post; downloads go through a short-lived
  signed URL. The type is judged by extension (`ATTACHMENT_TYPES` in
  `lib/change-log.ts`), not the browser's MIME: Windows reports a .csv as
  `application/vnd.ms-excel`, and legacy Office files often arrive untyped.
- Posting needs `changelog.post` (Engineer and above). Reading needs a
  session — sales holds a read-only role.
- The feed subscribes to the table, so a post appears without a refresh.

- **Replies, since 2026-09-23** (migration 065, `change_log_comments`). The
  post stayed a notice, but the question it raises — "does this affect the
  order we have in flight?" — was being asked by replying to the notification
  email, which put the answer in one inbox. A thread under each post keeps it
  with the change. Anyone with a session can reply; a reply tells the post's
  author and everyone already in the thread, not the workspace, and an
  @mention is told as a mention on top (`comment_mentions`, entity type
  `change_log_comment`). Edited replies are marked and withdrawals are soft,
  as for the post; the author edits, the author or an admin withdraws. The
  thread is always open under the post — a thread behind a click is one
  nobody reads — and the feed subscribes to the table too. A reply's
  notification links to `/change-log?post=<id>`, which the feed scrolls to.

**Not built, and deliberate:** no digest (every post notifies immediately, as
lead-time changes do), and no read receipts on replies — the post's receipt
says the change was seen; a reply is a conversation, and "who has read my
reply" is the chat this is not.

**Later, when ECOs are routine:** "post to the change log" becomes a checkbox
when a release is created, pre-filled from the ECO — the post's `releaseId`
and `ecoId` columns are there for exactly that. The table does not change;
what changes is who types the post.
