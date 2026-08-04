# Design tokens

**Status:** active
**Applies to:** every `className` in `src/app/`, `src/components/`, `src/features/`

## The rule

Use semantic token utilities. Never raw palette classes, never arbitrary pixel values.

| Instead of                    | Write                                    |
| ----------------------------- | ---------------------------------------- |
| `text-gray-500`               | `text-muted-foreground`                  |
| `bg-white` / `bg-gray-50`     | `bg-background` / `bg-card` / `bg-muted` |
| `border-gray-200`             | `border-border`                          |
| `text-red-600`                | `text-destructive`                       |
| `bg-green-100 text-green-800` | `<StatusBadge status="RELEASED" />`      |
| `h-[72px]`, `text-[13px]`     | `h-18`, `text-sm`                        |
| `rounded-[10px]`              | `rounded-lg`                             |

The tokens live in `src/app/globals.css` under `@theme inline`, and they are already wired for light and dark through `next-themes`.

## Status colours

Four semantic tokens carry every state colour in the product: `--success`, `--warning`, `--info`, `--neutral`, alongside the existing `--destructive`. Each is defined once per theme, so a status is theme-correct without a `dark:` override at the call site.

Do not reach for them directly to render a status. Use [`StatusBadge`](../../src/components/ui/status-badge.tsx), which maps a domain status to a tone in one place — see the "Status" section of `/admin/kitchen-sink`.

## The sub-`xs` type scale

Tailwind's scale stops at `text-xs` (12px). A data-dense PDM UI genuinely needs smaller steps for table meta text and badges, and without named ones every call site invented its own — 140 arbitrary values across four sizes. So the scale is extended rather than the rule exempted:

| Step       | Size | Use                                      |
| ---------- | ---- | ---------------------------------------- |
| `text-2xs` | 11px | secondary meta text in dense rows        |
| `text-3xs` | 10px | badge text, table sub-labels             |
| `text-4xs` | 9px  | the smallest legible step; use sparingly |

A bigger number is further from the base, continuing the `xs` → `2xl` pattern. If you want a size that is not on this list, add a step here rather than an arbitrary value at the call site.

## Why this is not bikeshedding

At the time of the audit there were **167** raw palette classes and **154** arbitrary pixel values in the codebase. Three concrete consequences:

1. **Dark mode is broken wherever a raw palette class appears.** `bg-white text-gray-900` stays white in dark mode. Every one of those 167 is either already wrong in dark mode or accidentally right.
2. **Status colors had no single definition.** `bg-green-100` meant "released" in one file, "approved" in another, and "in stock" in a third. Changing what released looks like meant finding all of them.
3. **Arbitrary pixels defeat the scale.** `h-[72px]` next to `h-16` next to `h-[70px]` is three values where the design has one.

## Enforcement

`npm run lint:tokens` scans `src/app`, `src/components`, and `src/features` and fails on:

1. Arbitrary pixel values in a Tailwind utility — `text-[13px]`, `h-[72px]`, `gap-[7px]`.
2. Raw Tailwind palette classes — `text-gray-500`, `bg-red-100`, `border-slate-200`.
3. Hardcoded hex colors in components.

Comments are ignored; they document intent and do not render.

## The allowlist

A small set of files may carry literal values because a token genuinely cannot work there:

- **`globals.css`** — where the tokens are defined.
- **The 3D viewer** — `three.js` materials take numeric colors, not CSS.
- **Canvas and PDF rendering** — `@napi-rs/canvas` and `pdfjs` draw with literal colors onto a bitmap.
- **Colour as data, not theme** — lifecycle states carry a customer-chosen colour persisted on the row. The hex literals in `api/tenants`, `api/lifecycle/[lifecycleId]/states`, and the lifecycle admin page are seeded defaults and fallbacks for that data, not design decisions.
- **Vendor component recipes** — `badge`, `dropdown-menu`, `scroll-area`, `tabs`, and `tooltip` are shadcn's own class recipes (`ring-[3px]` focus rings, `p-[3px]` tab padding, `rounded-[2px]` tooltip arrows). Rewriting them means diverging from upstream and re-doing the divergence on every component update, for no visual benefit. The rule still applies to everything composed from them.

**Adding a file to the allowlist is a decision, not a default.** If you reach for it for ordinary UI, you want a token.

## Where it stands

The burn-down is done: 373 violations at the time of the audit, **6 today**, all of them decorative gradient blobs on the marketing page (`w-[800px] blur-[120px]`) where the dimension is art direction and no scale step would mean anything. `scripts/tokens.baseline.json` holds those six and nothing else, so any new violation fails the build.

## Consequences

- A new status or state means adding it to the status token map, not writing colors at the call site.
- A design change ("our muted text is too light") is one line in `globals.css`.
- A one-off pixel value means either the scale is missing a step (add it to `@theme`) or the layout wants a different approach.
- Non-color arbitrary values that genuinely have no scale (a `max-w-[42ch]` measure, a `grid-cols-[auto_1fr]` template) are fine — the linter only flags `px`.
