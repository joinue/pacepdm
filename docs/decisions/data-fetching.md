# Data fetching

**Status:** active
**Applies to:** every read and every mutation initiated from the client

## Three patterns, and only three

**Server component — fetch directly.** The default for read-mostly pages. The async page component queries Supabase and passes plain data down. Add a `loading.tsx` beside the page so the user sees a skeleton during the fetch.

**Client component reads — `useFetch`.** For pages that need client state: filtering, refresh after a mutation, optimistic updates. [`src/hooks/use-fetch.ts`](../../src/hooks/use-fetch.ts) handles aborts on unmount and URL change, surfaces errors as `Error` instances rather than swallowing them, and returns `refetch` and `setData`.

**Mutations — `fetchJson`.** One-off POST/PUT/DELETE inside an event handler. [`src/lib/api-client.ts`](../../src/lib/api-client.ts) sets the content type, parses JSON safely even when the response is an HTML error page, and throws `ApiError` carrying the server's actual message. Catch it and feed `errorMessage(err)` to `toast.error`.

## What is banned, and why each one bites

```ts
fetch(url).then((r) => r.json());
```

Throws an unhelpful `SyntaxError` the moment the server returns an HTML error page or a 502 from the platform, which is precisely when you need a real message.

```ts
.catch(() => {})
```

Turns a real bug into a spinner that never stops. The user sees nothing, the logs record nothing.

```ts
try { ... } catch { toast.error("Failed to save") }
```

The server sent `"Part number PN-1042 already exists in this BOM"`. The user got "Failed to save". This is the most common and most damaging of the three, because it looks like error handling.

```ts
useState + useEffect + fetch;
```

Every hand-rolled instance is a missing abort on unmount (a `setState` on an unmounted component, or worse, a stale response overwriting a fresh one when the user navigates fast).

## The enforcement, and why it was needed

These rules were written down in `src/lib/README.md` well before this decision doc. At the time of the audit that produced it:

- `useFetch` was used **zero times**.
- There were **94** raw `await fetch(` calls in `.tsx` files.
- There were **14** generic `toast.error("Failed…")` calls against 47 correct `errorMessage(err)` calls.

The rules were right, well written, and completely ignored, because nothing checked. That is the actual lesson of this file: **a convention with no gate is a preference.**

So `npm run lint:conventions` now fails the build on a raw `fetch(` in a client component, on `.catch(() => {})`, and on a `catch` block that toasts a literal string. Fixing a violation means using one of the three patterns; silencing one means an inline comment justifying it, which shows up in review.

## Edge cases the linter allows

- **`fetch` inside `src/lib/` and `src/app/api/`** — server-side calls to external services are not this rule's business.
- **Streaming and binary responses** — file downloads and the zip stream read `response.body`, which `fetchJson` does not model. Use raw `fetch` with an explanatory comment.
- **`FormData` uploads** — `fetchJson` JSON-stringifies its body, and a multipart body must reach `fetch` untouched so the browser can set the boundary. Use **`uploadFile`** from [`src/lib/api-client.ts`](../../src/lib/api-client.ts): same `ApiError`, same server-message handling, no suppression comment needed. Raw `fetch` here is now a finding, not an exception.

## Consequences

- A new client-side read means `useFetch`. If it does not fit (paginated infinite scroll, polling), extend the hook rather than opening a second pattern.
- Every `catch` in a component ends in `toast.error(errorMessage(err))`. If you want extra context, prepend it: ``toast.error(`Could not check in: ${errorMessage(err)}`)``.
- If a third-party call genuinely needs raw `fetch` in a component, the comment justifying it is the deliverable, not the exception.

## Linking to a record

A link to a record carries that record's identifier. `/boms/<id>`,
`/parts?partId=<id>`, `/vault?fileId=<id>`, `/ecos?ecoId=<id>` — every one of
those destinations already supports being deep-linked, and every list page
already knows how to open the record it was given.

The failure is silent, which is what makes it worth a rule: nothing errors,
the user simply lands on an index and has to find by hand what they had
already clicked. Four separate call sites did this — a BOM line's source
cell, where-used rows in two different detail panels, and a file version's
"released by" ECO link — and each of them had the id in scope and dropped it.

`list-route-navigation` in [`scripts/lint-conventions.mjs`](../../scripts/lint-conventions.mjs)
flags a bare literal navigation to a record route. It is deliberately narrow:
a template literal or a query string cannot match, so only the shape that
provably carries no identifier trips it.

Returning to an index is legitimate — deselecting a record, a dashboard
summary card, clearing a deep link on close. Those take a
`lint-conventions-allow: list-route-navigation` comment saying which it is.
