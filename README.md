# PACE PDM

A multi-tenant product data management (PDM) app for engineering teams: file vault with checkout/checkin, BOMs, ECOs, approval workflows, and share links.

Built on Next.js 16 (App Router, Turbopack), React 19, Supabase (Postgres + Auth + Storage), and Tailwind.

## Local development

```bash
npm install
cp .env.example .env.local   # then fill in real values
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the dev server (Turbopack). |
| `npm run build` | Production build. |
| `npm start` | Run the production build. |
| `npm test` | Run the vitest unit suite. |
| `npm run e2e` | Run Playwright end-to-end tests. |
| `npm run lint` | Run ESLint. |

## Environment variables

See [`.env.example`](./.env.example) for the full list with descriptions. Required for any environment to start:

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_APP_URL`, `APP_URL`
- `RESEND_API_KEY`, `EMAIL_FROM`
- `CRON_SECRET`

`NEXT_PUBLIC_*` values are inlined at build time, so they must be set in the build environment (not just runtime).

## Deploy

The app is designed to deploy to any Node host. Vercel is the path of least resistance:

1. **Provision a Supabase project.** Capture the project URL, anon key, and service-role key for the env vars above.
2. **Run migrations.** Apply files in [`supabase/migrations/`](./supabase/migrations) in numeric order against the target database. Migrations are sequential — never skip or reorder. The most recent migrations as of launch are 037 (share-token access log) and 038 (BOM snapshot FK fix).
3. **Configure storage.** The vault uses a Supabase Storage bucket; create it and set the RLS policies that ship with the migrations.
4. **Set environment variables** in the hosting provider, matching `.env.example`. Use a freshly-generated random string for `CRON_SECRET`.
5. **Deploy.** Vercel: connect the repo, set env vars, push to `main`. Other hosts: run `npm run build` then `npm start`.
6. **Schedule cron.** The app exposes `/api/cron/approval-reminders`. Configure your scheduler (Vercel Cron, GitHub Actions, an external cron service) to hit it on a cadence (hourly is reasonable) with header `Authorization: Bearer $CRON_SECRET`.
7. **Verify.** Hit the deployed URL, register a workspace, invite a teammate, and exercise checkout/checkin and a share-link download to confirm storage + email + cron auth all work.

## Project layout

```
src/app/                Next.js App Router routes (UI + API)
src/components/         React components (UI primitives + features)
src/lib/                Server/client helpers (auth, db, validation, etc.)
src/hooks/              Client hooks
supabase/migrations/    Sequential SQL migrations
e2e/                    Playwright tests
```
