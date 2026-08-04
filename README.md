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

## Deploy

The app is designed to deploy to any Node host. Vercel is the path of least resistance:

1. **Provision a Supabase project.** Capture the project URL, anon key, and service-role key for the env vars above.
2. **Run migrations.** Apply files in [`supabase/migrations/`](./supabase/migrations) in numeric order against the target database. Migrations are sequential — never skip or reorder. The most recent migrations as of launch are 037 (share-token access log) and 038 (BOM snapshot FK fix).
3. **Configure storage.** The vault uses a Supabase Storage bucket; create it and set the RLS policies that ship with the migrations.
4. **Set environment variables** in the hosting provider, matching `.env.example`. Use a freshly-generated random string for `CRON_SECRET`.
5. **Deploy.** Vercel: connect the repo, set env vars, push to `main`. Other hosts: run `npm run build` then `npm start`.
6. **Schedule cron.** The app exposes `/api/cron/approval-reminders`. Configure your scheduler (Vercel Cron, GitHub Actions, an external cron service) to hit it on a cadence (hourly is reasonable) with header `Authorization: Bearer $CRON_SECRET`.
7. **Verify.** Hit the deployed URL, register a workspace, invite a teammate, and exercise checkout/checkin and a share-link download to confirm storage + email + cron auth all work.

`@napi-rs/canvas`, `pdfjs-dist`, and `sharp` are declared as `serverExternalPackages` in `next.config.ts` because they load platform-specific native bindings that the bundler cannot resolve. Server-side thumbnail generation breaks if that changes.

## Project layout

```
src/app/                Next.js App Router routes (UI + API)
src/components/         React components (UI primitives + features)
src/lib/                Server/client helpers (auth, db, validation, etc.)
src/hooks/              Client hooks
supabase/migrations/    Sequential SQL migrations
e2e/                    Playwright tests
```
