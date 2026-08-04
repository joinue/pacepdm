# Migrations are hand-applied

**Status:** active
**Applies to:** everything in `supabase/migrations/`

## What actually happens

Migrations are raw SQL files named `migration-NNN-<slug>.sql`, applied by **pasting them into the Supabase SQL editor**. There is no ORM migration runner, no `supabase db push`, no CI step that applies them. The number is a monotonic sequence, not a timestamp.

This surprises people, so it is the first thing to internalize: **the contents of `supabase/migrations/` describe what someone intended, not what is live.**

## Why

The project has one production Supabase instance and one operator. A migration runner buys atomic apply-and-record, which matters when several engineers deploy independently. It costs a toolchain, a shadow database, and a `_migrations` ledger that silently desynchronizes the first time anything is applied out of band — which, with dashboard access available, always eventually happens. Given the team size, running the SQL by hand and verifying the result is both simpler and more honest about where the truth lives.

The cost is real and is paid by these rules.

## The rules

**1. Every migration is idempotent and re-runnable.**

The operator may paste a file twice, or paste it after having already applied part of it by hand while debugging. Every statement must tolerate that:

```sql
create table if not exists "widgets" (...);
alter table "widgets" add column if not exists "notes" text;
drop policy if exists "tenant_read" on "widgets";
create policy "tenant_read" on "widgets" for select using (...);
create index if not exists "widgets_tenantId_idx" on "widgets" ("tenantId");
```

`enable row level security` is naturally a no-op when already enabled. `create policy` is not — always precede it with `drop policy if exists`.

**2. Migrations are additive.**

No destructive `drop column`, no data-losing `alter type`. If a column must go, stop writing to it first, ship, then remove it in a later migration once nothing reads it.

**3. Lead with a comment block.**

Every migration opens with prose explaining what it closes or enables, what threat model or requirement drove it, what was verified before writing it, and what was deliberately left out of scope. [`migration-039-rls-lockdown.sql`](../../supabase/migrations/migration-039-rls-lockdown.sql) is the reference: it records the exact `curl` responses that proved the exposure. In a repo where the files are not the source of truth, this comment block _is_ the record.

**4. Verify by introspection, never by file.**

Before assuming a migration is live, ask the database:

```sql
-- Is RLS actually on?
select relname, relrowsecurity from pg_class
where relnamespace = 'public'::regnamespace and relkind = 'r';

-- What policies exist?
select tablename, policyname, cmd, qual from pg_policies where schemaname = 'public';

-- Does the column exist?
select column_name, data_type from information_schema.columns where table_name = 'widgets';
```

There is precedent in similar projects for a `drop policy` that lived in source for months without ever having been run. Assume nothing.

**5. Code tolerates an unapplied migration where it cheaply can.**

[`src/lib/folder-access.ts`](../../src/lib/folder-access.ts) already does this: it detects the Postgres "function does not exist" error codes and degrades instead of 500-ing when `get_folder_access_scope` is missing. Do this for optional capabilities. Do not do it for security controls — a missing RLS migration must be loud.

## Consequences

- Adding a migration is not the same as shipping it. Say so explicitly in the PR: "needs applying to prod before deploy."
- A migration that is not re-runnable will eventually be run twice and fail halfway, leaving the schema in a state no file describes.
- Because the numbering is a sequence, two branches adding `migration-040-*` collide. Check the highest number on `main` before naming yours.
- Anything that must be true of the live database (RLS posture, in particular) needs a runtime check, not a file. That is what `npm run probe:rls` is for. See [`rls-new-tables.md`](rls-new-tables.md).
