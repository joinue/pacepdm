# Supplier access: shares resolve at view time, and release released work by default

**Status:** active
**Applies to:** `share_tokens`, `src/lib/part-package.ts`, `src/lib/releases.ts`, `/api/public/share/*`

## The rule

There are two ways to hand engineering data to someone outside the company,
and they answer different questions:

| Question the recipient is asking         | What to send        | What it does                                             |
| ---------------------------------------- | ------------------- | -------------------------------------------------------- |
| "What is current for this part?"         | A **part** share    | Resolves the part's released documents on every request. |
| "What exactly did change order 14 ship?" | A **release** share | Reads a frozen jsonb manifest. Never moves.              |

Never make a part share behave like a release, and never make a release
behave like a part share. The opposite choices are the whole point.

A part share contains **released files only** unless the link explicitly opts
in, and anything it lets through beyond that is stamped PRELIMINARY on every
surface that renders it. See
[Why there is a WIP opt-in anyway](#why-there-is-a-wip-opt-in-anyway-and-what-it-must-always-carry).

## Why a part share resolves at view time

Sourcing sends a supplier a link in March. In June an ECO revises the part.
The supplier is working from whatever that link shows them.

If the package were frozen when the link was minted, it would silently be
wrong from June onward — and nothing would tell either side. That is the exact
failure this feature exists to eliminate: the old workflow was one share link
per file, minted by hand, with no guarantee the set was complete and no
mechanism at all for it to stay current. Freezing the set would have kept the
convenience and kept the bug.

So the package is resolved on each request, and the public viewer says so in
plain language: _"This page always shows the current released documents. Check
back here rather than saving a copy."_ The recipient needs to know the link is
live, or they will save a PDF and stop looking.

**The cost, accepted deliberately:** a supplier cannot use a part share to
prove what they were told in March. That is what a release share is for, and
it is why both exist.

## Why a release does the opposite

A release is history. `createReleaseFromEco` freezes parts, files and BOM
snapshots into a jsonb manifest at implement time, and the release page and
public viewer read the manifest rather than live tables. A part renamed or
deleted next year does not change what a historical release shows.

If releases resolved live, the compliance story would evaporate — "what we
shipped" would silently become "what we have now."

## Why released files only, by default

`part_files` links whatever an engineer attached, including work in progress.
A WIP drawing in front of a supplier is precisely the accident the vault's
lifecycle states exist to prevent, so `buildPartPackage` filters on it.

The filter is silent to the guest and loud to the sender:

- The **public payload never carries `filesWithheld`.** A supplier has no
  business learning that other drawings exist.
- The **share dialog shows it before the link is minted** — "4 documents
  included · 2 withheld (not released)" — because after the link is sent it is
  too late, and a sender who believes they sent a complete set is the person
  this hurts.

## Why there is a WIP opt-in anyway, and what it must always carry

The released-only default assumes a release process is running. At PACE, as of
2026-08-05, one is not: every file in the vault is WIP, so a part share
resolves to an empty package and sourcing cannot get a quote at all. Quoting
genuinely does have to happen before a formal release.

The wrong fix is to relax the default. The right one is to let a **single
link** opt in, and make the resulting package say so everywhere it can be
read. `share_tokens.includeWip` (migration 050) does that:

- **Off by default**, reset every time the dialog opens. An opt-in that
  persists between dialogs is one somebody eventually sends without meaning to.
- **Persisted on the token, not passed per request**, so "was this supplier
  sent preliminary drawings, and who decided that" is answerable months later.
  `share.create` records it in the audit log too.
- **Rejected on any non-part resource type** rather than stored and ignored —
  a stored flag nothing reads later looks like permission that was granted.

**Every renderer must stamp it.** This is the part to preserve if you change
anything here, because the opt-in is only safe while the label is unavoidable:

| Surface             | Stamp                                                  |
| ------------------- | ------------------------------------------------------ |
| Viewer, per row     | `PRELIMINARY — NOT FOR PRODUCTION` badge               |
| Viewer, per package | Warning banner above the specs and the download button |
| Zip, per file       | Filename prefixed `PRELIMINARY-`                       |
| Zip, per archive    | `READ-ME-FIRST.txt`                                    |
| Manifest            | `preliminary: true`, `containsPreliminary`             |

The filename prefix is the one that matters most and is the easiest to think
unnecessary. Once a zip is extracted onto a supplier's desktop the filename is
the only context that survives — the manifest goes unread, the web page is
closed, and the drawing gets emailed onward on its own.

Released files also sort **before** preliminary ones, so a recipient reading
only the top of the list reads the approved work.

Widening the default means editing `SHAREABLE_STATES` in
[`part-package.ts`](../../src/lib/part-package.ts), which should require an
argument, not a shrug.

## Consequences for anything you build next

- **A new share resource type needs four things**, and missing any one of them
  fails at runtime rather than at compile time: the `ShareResourceType` union,
  a branch in `/api/public/share/[token]` (display name) and
  `/api/public/share/[token]/content`, and **a widened CHECK constraint on
  both `share_tokens.resourceType` and `share_token_access.resourceType`**.
  The access log constraint is the one that gets forgotten — `logShareAccess`
  is void-called as a side effect, so a rejected insert is silent.
- **Do not add a "share this folder" or "share these N files" type** without
  first deciding which of the two models above it follows. A frozen set of
  files is a release; a live view of a container is a part share. There is no
  third thing.
- **The zip is the same package as the page.** `/api/parts/[partId]/zip`
  (internal, authenticated) and `/api/public/share/[token]/zip` (guest, token)
  both call `buildPartZipStream` over the same `buildPartPackage` result, so
  the emailed attachment and the link cannot disagree.
- **A new way to render a package must stamp preliminary files.** The table
  above is the contract, not a description of the current implementation. A
  renderer that omits the stamp turns a deliberate opt-in back into the silent
  accident it was designed to replace.

## Related

- [`bom-structure.md`](bom-structure.md) — the same derived-vs-declared split, applied to hierarchy
- [`tenant-isolation.md`](tenant-isolation.md) — `buildPartPackage` takes a raw client and scopes by the tenantId passed in, the `captureBomSnapshot` contract
