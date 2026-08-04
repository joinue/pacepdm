# Feature folders

**Status:** active
**Applies to:** all non-shared UI code

## The problem

The vault — the app's largest feature — was spread across five directories:

```
src/app/(dashboard)/vault/page.tsx      the route
src/components/vault/*                  10 components
src/hooks/vault/*                       7 hooks
src/lib/folder-access.ts                its authorization model
src/app/api/files/**, src/app/api/folders/**   its routes
```

Nothing was wrong with any individual file. The problem was that understanding the vault meant opening five trees, and that `src/components/` had become a bag holding both shared primitives and one feature's internals. A newcomer could not tell from the layout which components were safe to reuse.

## The decision

Feature code lives in `src/features/<feature>/`. A feature folder owns its components, hooks, types, and client-side data access, and you should be able to understand the feature by reading its folder:

```
src/features/vault/
  components/       its UI
  hooks/            its hooks
  types.ts          its shared types
  index.ts          the public surface other code may import
```

What stays where it is:

- **`src/components/ui/`** — genuinely shared primitives. `Button`, `Dialog`, `PageHeader`, `EmptyState`. If two unrelated features use it, it belongs here.
- **`src/components/layout/`** — app chrome. Sidebar, header, global search.
- **`src/lib/`** — cross-cutting helpers with no UI. The API wrapper, the approval engine, the permission model, validation.
- **`src/app/`** — routes only. A `page.tsx` should be thin: resolve params, fetch, render a feature component.
- **`src/app/api/`** — route handlers stay in the App Router tree, because Next.js requires it.

## The import rule

**Import a feature through its `index.ts`, never through its internals.**

```ts
import { VaultBrowser } from "@/features/vault"; // yes
import { VaultBrowser } from "@/features/vault/components/vault-browser"; // no
```

Within a feature, import relatively (`./components/x`) and freely. The barrel is the seam that lets a feature reorganize its insides without touching anything else.

This is checked by `npm run lint:conventions`. Cross-feature deep imports are the specific failure mode that turns feature folders back into a flat directory with extra steps.

## Why not colocate routes inside the feature folder

Next.js owns `src/app/`. Route files must live where the router expects them. So a feature is two places, not one: the thin route in `src/app/` and the substance in `src/features/`. This is the one seam the framework forces, and keeping route files thin is what keeps it cheap.

## When to create a feature folder

When it has more than about three files, or when it has its own hooks or types. Below that, a single component in the route folder is fine. Do not create `src/features/profile/` for one page.

Do not create a feature folder for something two other features already share. That is a primitive or a lib helper.

## Consequences

- A new feature starts as `src/features/<name>/` with an `index.ts`.
- Moving a component out of `src/components/` into a feature is not a refactor to defer; it is the answer to "is this shared?" being no.
- A component that two features import is a signal: either promote it to `src/components/ui/` or one of the features owns it and the other should not be reaching for it.
