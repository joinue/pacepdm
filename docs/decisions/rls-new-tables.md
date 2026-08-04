# RLS on new tables

**Status:** active
**Applies to:** every `create table` in `supabase/migrations/`

## Why this exists at all, given the app never uses RLS

Every server route uses `getServiceClient()`, which authenticates with the service-role key and **bypasses RLS entirely**. So RLS protects nothing the app does. It protects against everything the app _is not_:

`NEXT_PUBLIC_SUPABASE_ANON_KEY` ships inside the JavaScript bundle. It is public by definition, and PostgREST is reachable from anywhere with `curl`. Supabase's default grants give `anon` full DML on the `public` schema. A table with RLS disabled has nothing standing between it and the internet.

This was not hypothetical here. Before `migration-039`, verified against the live project:

```
GET    /rest/v1/tenant_users  → 206  Content-Range: 0-0/5
GET    /rest/v1/share_tokens  → 206  Content-Range: 0-0/3
GET    /rest/v1/audit_logs    → 206  Content-Range: 0-0/102
DELETE /rest/v1/audit_logs?id=eq.<no-match>  → 204   (write granted)
```

Unauthenticated, from anywhere: every user's email, every share token (each of which grants file downloads in its tenant), the full audit trail — readable, and deletable, including the audit trail that would have recorded the tampering.

## How it got that way

The rollout was three migrations and the middle one drew the line in the wrong place:

- **022** added a Custom Access Token hook injecting `app_metadata.tenantId` into every JWT, so policies would have a claim to read.
- **023** enabled RLS and added SELECT policies on the 11 tables the browser subscribes to via realtime. It deliberately left the other 29 alone, reasoning that "the browser never queries these directly today."
- **039** enabled RLS on the remaining 29.

023's reasoning applies the wrong threat model. What the browser does is irrelevant; what `curl` can do is the question. **"No client code reads this table" is never a reason to leave RLS off.**

## The rule

**Every new table gets `ENABLE ROW LEVEL SECURITY` in the same migration that creates it.** Not a follow-up migration, not "when we wire up the UI".

Then pick a posture:

**Deny-all (RLS on, zero policies)** — the default, and correct for any table reached only through server code via the service role. Sufficient and non-breaking: `anon` and `authenticated` get zero rows and every write is refused, while every server route is untouched. This is what 039 did for all 29 tables.

**A scoped SELECT policy** — only when the browser genuinely needs direct access, which in practice means the table is in a realtime subscription. Read the tenant from the JWT claim, never from a request parameter:

```sql
drop policy if exists "tenant_read" on "widgets";
create policy "tenant_read" on "widgets" for select
  using ("tenantId" = (auth.jwt() -> 'app_metadata' ->> 'tenantId'));
```

Write policies are still deliberately absent app-wide. Every mutation goes through a server route on the service role, so a write policy would be dead code that has to be kept correct forever. If you add one, say why in the migration.

**Permissive, not `FORCE`.** `FORCE ROW LEVEL SECURITY` applies policies to the table owner and service role too, which would break every route in the app instantly.

## Verifying

Do not trust the migration file. Run:

```
npm run probe:rls
```

It hits the live PostgREST endpoint as `anon` (and as a freshly created throwaway account) against every table in its list, and fails if any row comes back or any write is accepted. **Add every new table to its list in the same PR that creates the table.** A table absent from the list is untested, and the probe passing means nothing about it.

## Consequences

- A new `create table` without a matching `enable row level security` fails review.
- A new realtime subscription means a new SELECT policy, and the policy must read the JWT claim. A `using (true)` policy is never acceptable on a tenant-scoped table.
- If a future feature needs browser access to a currently deny-all table, add the policy in that feature's PR, where the required shape is actually known. Do not pre-emptively write policies for tables nothing reads.
- RLS is not a substitute for the tenant filter in app code. The service role bypasses it. See [`tenant-isolation.md`](tenant-isolation.md).
