# Conventions for `src/lib/` and `src/hooks/`

These notes exist so future contributors don't have to reverse-engineer
the patterns. If you change a convention, update this file.

## Data fetching

Pick the pattern that matches your context. Don't write raw `fetch()` in pages.

### Server components — fetch directly

For pages where you can render entirely on the server, fetch directly in
the async page component using the Supabase service client. This is the
default for read-mostly pages with no client interactivity.

```tsx
// src/app/(dashboard)/dashboard/page.tsx
export default async function DashboardPage() {
  const tenantUser = await getCurrentTenantUser();
  const db = getServiceClient();
  const { data } = await db.from("files").select("*").eq("tenantId", tenantUser.tenantId);
  return <DashboardClient files={data || []} />;
}
```

Add a `loading.tsx` next to the page so users see a skeleton during
the server fetch.

### Client components — `useFetch`

For pages that need client-side state (filtering, refresh after
mutations, optimistic updates), use [`useFetch`](../hooks/use-fetch.ts).

```tsx
"use client";
import { useFetch } from "@/hooks/use-fetch";

export default function NotificationsPage() {
  const { data, loading, refetch, setData } = useFetch<Notification[]>("/api/notifications");
  // ...
}
```

`useFetch` handles aborts, error surfacing, and refetching for you.
**Do not** write `useState + useCallback + useEffect + fetch` boilerplate.

### Mutations — `fetchJson`

For one-off mutations (POST/PUT/DELETE) inside event handlers, call
[`fetchJson`](api-client.ts) directly. It throws `ApiError` with the
real server message on failure, which you should pass to `toast.error`
via `errorMessage(err)`.

```tsx
import { fetchJson, errorMessage } from "@/lib/api-client";

async function handleSubmit() {
  try {
    await fetchJson("/api/boms", { method: "POST", body: { name } });
    toast.success("Created");
    refetch(); // re-run the useFetch
  } catch (err) {
    toast.error(errorMessage(err));
  }
}
```

### Never

- ❌ `fetch(url).then(r => r.json())` — no error handling, crashes on non-JSON
- ❌ `.catch(() => {})` — silently swallows real errors
- ❌ `try { ... } catch { toast.error("Failed") }` — hides the actual error message
- ❌ Raw `useState + useEffect + fetch` — use `useFetch` instead

## Request validation

Every API route that accepts a JSON body must validate it with `zod` via
[`parseBody`](validation.ts). This is non-negotiable — without it, the
route is trusting whatever shape the client happened to send.

```ts
import { z, parseBody, nonEmptyString, optionalString } from "@/lib/validation";

const CreateBomSchema = z.object({
  name: nonEmptyString,
  description: optionalString,
});

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const parsed = await parseBody(request, CreateBomSchema);
    if (!parsed.ok) return parsed.response;
    const { name, description } = parsed.data; // fully typed and validated

    // ... safe to use name/description
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create BOM";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

`parseBody` returns a discriminated result so you can short-circuit cleanly:
on validation failure it gives you a `NextResponse` to return directly with
a 400 status and a field-level error map.

Reusable schema fragments (`nonEmptyString`, `optionalString`, `optionalUuid`,
`positiveNumber`, etc.) live in [`validation.ts`](validation.ts) — compose
them into route schemas instead of re-declaring `z.string().trim().min(1)`
everywhere.

For partial-update PUT routes, use `.refine()` to require at least one
field:

```ts
const UpdateSchema = z.object({
  name: z.string().trim().min(1).optional(),
  status: z.string().optional(),
}).refine(
  (v) => v.name !== undefined || v.status !== undefined,
  { message: "At least one field is required" }
);
```

### Catch blocks

The catch block at the end of a handler should surface the real error
message instead of a generic string. This makes 500s debuggable:

```ts
} catch (err) {
  const message = err instanceof Error ? err.message : "Failed to do thing";
  return NextResponse.json({ error: message }, { status: 500 });
}
```

❌ Don't write `} catch { return NextResponse.json({ error: "Failed" }) }`
— that hides the actual cause and the only way to debug it is server logs.

## Permissions

Server-side checks in API routes are the source of truth. Use
[`hasPermission`](permissions.ts) inside route handlers — every mutating
endpoint should check.

For UI gating (hiding buttons the user can't use), use the
[`usePermissions`](../hooks/use-permissions.ts) hook in client components:

```tsx
const { can } = usePermissions();
{can(PERMISSIONS.FILE_DELETE) && <DeleteButton />}
```

Hidden buttons are a UX optimization, not a security boundary. The
server still enforces.

## State machines

BOM and ECO status flows live in [`status-flows.ts`](status-flows.ts).
Both client pages and API routes import from there. Never inline a
new copy of `BOM_STATUS_FLOW` or `ECO_STATUS_FLOW`.

## Side effects

Notifications, mention processing, and other non-critical async work
that runs *after* a mutation completes should be wrapped in
[`sideEffect`](notifications.ts) so failures are logged with context
instead of swallowed:

```ts
await sideEffect(
  notify({ ... }),
  "notify ECO submitter about status change"
);
```

The wrapped operation can fail without breaking the main response.

## Error boundaries

Wrap feature-level subtrees (file detail panel, BOM editor) in
[`<ErrorBoundary>`](../components/ui/error-boundary.tsx) so a render
crash in one panel doesn't take down the whole page. Don't wrap
the entire app — that defeats the purpose.

## Empty states & loading

- Empty states: [`<EmptyState>`](../components/ui/empty-state.tsx) — never copy-paste another `<Card><CardContent className="py-12 text-center">` pattern
- Loading skeletons: [`<Skeleton>`](../components/ui/skeleton.tsx) for inline,
  or a Next.js `loading.tsx` file next to the page for server components

## The vault hook

`useVaultBrowser` is a thin facade around seven smaller hooks under
[`src/hooks/vault/`](../hooks/vault/). Each smaller hook owns one concern
(navigation, contents, selection, filter, single-file actions, bulk
actions, drag-and-drop). If you need to add vault behavior, add it to
the relevant sub-hook — don't fatten the facade.
