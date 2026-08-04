# PACE PDM

Product data management for small and medium hardware teams. A file vault with revision control and check-in/check-out, multi-level BOMs with cost and quantity rollup, engineering change orders with configurable approval workflows, releases, vendor records, and a complete audit trail.

Multi-tenant SaaS on Next.js 16 and Supabase.

## Getting started

```bash
npm install
cp .env.example .env.local   # then fill in the values below
npm run dev                  # http://localhost:3000
```

There is no local database. The app talks to whichever Supabase project `.env.local` points at.

### Environment

| Variable                        | Purpose                                                        |
| ------------------------------- | -------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | Supabase project URL                                           |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public anon key. **Ships in the JS bundle** — treat as public. |
| `SUPABASE_SERVICE_ROLE_KEY`     | Server-only. Bypasses RLS. Never expose to the client.         |
| `NEXT_PUBLIC_APP_URL`           | Canonical app origin, used in share links and emails           |
| `NEXT_PUBLIC_MARKETING_URL`     | Marketing site origin                                          |
| `APP_URL`                       | Server-side app origin                                         |
| `RESEND_API_KEY`                | Transactional email                                            |
| `EMAIL_FROM`                    | Sender address for notification email                          |
| `CRON_SECRET`                   | Shared secret authenticating the Vercel cron invocation        |

### Database

Migrations are raw SQL in `supabase/migrations/`, applied **by hand** through the Supabase SQL editor in numeric order. There is no migration runner, and the files are not a ledger of what is live. Read [`docs/decisions/hand-applied-migrations.md`](docs/decisions/hand-applied-migrations.md) before touching them.

## Documentation

**New here? Read [`docs/ENGINEERING.md`](docs/ENGINEERING.md) first.** It is the fifteen-minute tour of how the pieces fit and which conventions will surprise you.

|                                              |                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------- |
| [`AGENTS.md`](AGENTS.md)                     | The rulebook. Concise, imperative, loaded by AI tools each session. |
| [`docs/ENGINEERING.md`](docs/ENGINEERING.md) | The engineering tour                                                |
| [`docs/decisions/`](docs/decisions/)         | Standing decisions and the reasoning behind them                    |
| [`docs/GLOSSARY.md`](docs/GLOSSARY.md)       | PDM vocabulary, and where each concept lives in the code            |

## Commands

| Command                    | What it does                                                      |
| -------------------------- | ----------------------------------------------------------------- |
| `npm run dev`              | Dev server                                                        |
| `npm run build`            | Production build                                                  |
| `npm test`                 | Vitest unit suite                                                 |
| `npm run test:watch`       | Vitest, watching                                                  |
| `npm run test:coverage`    | Coverage report                                                   |
| `npm run e2e`              | Playwright journeys                                               |
| `npm run typecheck`        | `tsc --noEmit`                                                    |
| `npm run lint`             | ESLint                                                            |
| `npm run lint:tokens`      | Design-token discipline (no raw palette classes, no arbitrary px) |
| `npm run lint:conventions` | Data-fetching, import, and route-wrapper discipline               |
| `npm run check`            | Everything above. Run before you push; CI runs the same.          |
| `npm run probe:rls`        | Hits live PostgREST as `anon`; fails on any leaked row            |
| `npm run format`           | Prettier                                                          |

A pre-commit hook formats and lints staged files and typechecks the project.

## Architecture in brief

- **`src/app/`** — App Router. `(dashboard)` is the signed-in app, `(auth)` is login, `share/[token]` is the public share viewer, `marketing` is the public site. `api/` holds ~98 route handlers.
- **`src/features/<feature>/`** — feature code, imported through each feature's `index.ts`.
- **`src/components/ui/`** — shared primitives. **`src/components/layout/`** — app chrome.
- **`src/lib/`** — the route wrapper, the API client, and the engines (approvals, BOM rollup, folder access, permissions, status flows).

Two conventions carry more weight than the rest:

1. **Every API route is wrapped in `withTenant`**, which resolves the session, checks the declared permission, validates the body, and hands the handler a **tenant-scoped** database client. You never write a tenant filter, so you cannot forget one. → [`docs/decisions/api-route-contract.md`](docs/decisions/api-route-contract.md)

2. **Every new table gets RLS enabled in the migration that creates it.** The anon key is public, so a table without RLS is readable by anyone with `curl`. → [`docs/decisions/rls-new-tables.md`](docs/decisions/rls-new-tables.md)

## Deployment

Vercel. `vercel.json` registers one cron (`/api/cron/approval-reminders`, every 30 minutes), authenticated with `CRON_SECRET`.

`@napi-rs/canvas`, `pdfjs-dist`, and `sharp` are declared as `serverExternalPackages` in `next.config.ts` because they load platform-specific native bindings that the bundler cannot resolve. Server-side thumbnail generation breaks if that changes.
