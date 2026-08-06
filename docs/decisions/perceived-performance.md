# Perceived performance

**Status:** active
**Applies to:** navigation, mutations, and any surface with a realtime subscription

The app felt slow while being, mostly, fast. Four separate causes, none of them
query performance. Each has a standing rule now.

## 1. Resolve the caller once per request

`getCurrentTenantUser()` costs **two network round-trips**: `supabase.auth.getUser()`
validates the JWT against the Supabase Auth server (it does not decode it
locally), then `findTenantUser` joins `tenants` and `roles`.

The dashboard layout needs the caller and so does the page beneath it, so an
uncached implementation paid that twice before rendering a byte. Both public
entry points in [`src/lib/auth.ts`](../../src/lib/auth.ts) now delegate to one
`cache()`-wrapped resolver.

**Rule:** any helper that reads the session or the tenant user is wrapped in
React's `cache()`. It memoises per request — nothing is shared across requests
or users. If you add a third entry point, route it through the same cached
resolver rather than writing a second one; two cached functions that each do
the work is the same bug with more steps.

The resolver returns a status union (`ok` / `unauthenticated` / `no-tenant`)
rather than `TenantUser | null` because the two failure modes redirect to
different places, and collapsing them would lose that.

## 2. Mutations apply locally first, then reconcile

The old shape was `await fetchJson(...)` then `refresh()` — two sequential
round-trips before the row visibly changed. Every vault action felt laggy for
that reason alone.

Now: apply the expected result to the local list, fire the request, and either
reconcile with a refresh or roll back. [`use-vault-contents.ts`](../../src/hooks/vault/use-vault-contents.ts)
exposes `patchFile` / `removeFile` / `patchFolder` / `removeFolder`; each
returns its own rollback.

**Rollbacks are row-scoped, never whole-list snapshots.** A realtime event or a
concurrent refresh may have landed between the optimistic edit and the failure,
and restoring a stale snapshot would clobber it. `removeFile`'s rollback also
checks whether the row is already back before re-inserting, or a refresh that
beat the failure would produce a duplicate.

**Rule:** a mutation that changes something already on screen updates it
optimistically. A mutation whose result the user cannot see yet (an upload, an
export) does not need it. When the server's response can contradict the
optimistic value — a transition that comes back `pendingApproval` instead of
the new state — roll back and apply what actually happened.

## 3. Realtime must not replay your own writes

A surface that both refreshes after its own mutation _and_ subscribes to
realtime on the same table fetches twice per user action: once explicitly, then
again when Postgres replays the write back to the tab that made it.

[`useRealtimeEchoGuard`](../../src/hooks/use-realtime-echo-guard.ts) marks a
local write; the realtime handler skips its refresh for a short window
afterwards. The explicit refresh already has the fresh rows.

The trade-off is deliberate and worth knowing: **a teammate's write landing
inside the same window is also skipped.** That costs at most the window
(1500ms by default, sized to cover `useRealtimeTable`'s 250ms debounce plus
replication lag), because any later event refreshes normally.

**Rule:** if a component calls `useRealtimeTable` on a table it also writes to,
it needs the guard. Wire it by wrapping the refresh the mutations call, so new
mutations are covered without anyone remembering to mark them.

Applied on the vault browser, the file detail panel, the parts page, the
approvals page, and the ECOs view. One deliberate exception: the ECO view's
`approval_decisions` subscription is **not** guarded, because an approval
arriving there is usually somebody else's, and the decisions list is exactly
what the user is watching when it lands.

## 3b. Do not fetch a list to count it

`NotificationProvider` needed a badge number and got it from
`GET /api/approvals` — full decision rows with three nested joins — then called
`.length`. That ran on mount, on every tab focus, on a 60s timer, and on every
`approval_decisions` change anywhere in the database. The app's heaviest read
was also its most frequent, for a number.

`GET /api/approvals/count` now does it as a head-only `count: "exact"` query,
with the parent-request check pushed into an `!inner` join so it stays a count
rather than a fetch-then-filter.

**Rule:** if the UI renders a count, the endpoint returns a count. When the
filter involves a related table, `!inner` plus a filter on the embedded column
keeps it countable — see that route for the shape.

**And: background tabs should not poll.** The same provider's safety poll now
skips its tick unless `document.visibilityState === "visible"`. Nothing is
lost, because the existing focus/visibility handler refetches on return, which
is sooner than the next tick would have come anyway.

## 3c. Every segment that can throw has an `error.tsx`

There were none. A throw in a server component escaped to Next's default error
page: unstyled, no shell, no navigation, no way back — indistinguishable from
the app being down.

Compose from [`RouteError`](../../src/components/ui/route-error.tsx). Note the
prop is **`retry`**, not `reset` — Next renamed it, stable as of 16.3, and the
old name silently gives you an undefined callback rather than a type error if
you destructure loosely.

`global-error.tsx` covers a throw in the root layout itself. It replaces the
whole document, so it renders its own `<html>`/`<body>` with inline styles —
the token stylesheet may not have loaded, which is why the token linter should
not be "fixed" there.

**Rule:** a segment that fetches gets `error.tsx`. A dynamic segment that calls
`notFound()` gets `not-found.tsx` beside it, or the 404 lands outside the
dashboard shell and dumps the user out of the app.

## 4. Loading skeletons match the page they stand in for

Every dashboard route is dynamic — the layout reads the session cookie — so
`<Link>` prefetches each route only as far as the nearest loading boundary.
That much is fine and was already working: `(dashboard)/loading.tsx` wraps
every nested route.

The problem was that it wrapped them with the _same_ skeleton: five stat cards
and an activity feed, which is right for the dashboard home and wrong for every
list, detail, and form page under it. The prefetched fallback appeared
instantly and then shifted hard into an unrelated layout, which reads as
slower than showing nothing.

Compose from [`src/components/ui/page-skeleton.tsx`](../../src/components/ui/page-skeleton.tsx)
— `ListPageSkeleton`, `MasterDetailSkeleton`, `RecordPageSkeleton`,
`FormSkeleton`, `TableSkeleton` — so a route-level `loading.tsx` is two or
three lines.

Pick by the shape the route resolves to, not by the word "detail":

| Route shape                                               | Composition                           |
| --------------------------------------------------------- | ------------------------------------- |
| Header, toolbar, table                                    | `ListPageSkeleton`                    |
| List column beside the record it selects (BOMs, ECOs)     | `MasterDetailSkeleton`                |
| One record on its own page, opened from a link (releases) | `RecordPageSkeleton`                  |
| A form                                                    | `PageHeaderSkeleton` + `FormSkeleton` |

**Rule:** a route segment that fetches gets its own `loading.tsx`, shaped like
what it resolves to — same header, same table columns, same card count. A
skeleton that lies is worse than a spinner.

This is easy to get subtly wrong. BOMs, ECOs and releases all rendered a single
`DetailPageSkeleton` whose aside sat on the **right** at `lg:w-72`. All three
are the mirror of that or not two-pane at all, so every one of them visibly
swapped sides on load — the failure the rule exists to prevent, reintroduced by
a composition whose name sounded close enough.

## 5. Keep heavy viewers out of the page bundle

`cad-viewer.tsx` statically imports all of three.js (~150 KB gzipped) and is
reachable from the file detail panel, which the vault browser renders eagerly —
so every vault user downloaded a WebGL renderer whether or not they ever opened
a STEP file.

Import [`cad-viewer-lazy.tsx`](../../src/components/vault/cad-viewer-lazy.tsx),
never `cad-viewer` directly.

**Rule:** a dependency only some users need, behind a preview or a tab, goes
through `next/dynamic`. Check what a route actually ships before assuming it is
tree-shaken — a static import from an eagerly-rendered component is not.

## Not done, and the honest reason

`cacheComponents: true` + `partialPrefetching: true` (Next 16.3) is the real
fix for dynamic-route prefetching: one reusable App Shell per route instead of
all-or-nothing. It is a meaningful migration — every uncached read needs a
`Suspense` boundary and a caching directive — and it was deferred rather than
rushed alongside the items above. It is the next thing to do here.
