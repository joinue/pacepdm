-- PACE PDM Migration 054: one active workspace membership per account
--
-- Closes a lockout any stranger could trigger (AUD-003 SEC-1).
--
-- Sign-in resolves the caller with
--   tenant_users where "authUserId" = <me> and "isActive" → .single()
-- which fails when two rows match, so the user resolves to no workspace and
-- is sent to onboarding. Nothing in the schema stopped a second active row:
-- the only guard was a check in POST /api/users/invite that compared
-- tenant_users.email case-sensitively, while the auth-account lookup right
-- after it lowercased. Inviting `Bob@Acme.com` walked past Bob's
-- `bob@acme.com` membership, found his account, and inserted a second active
-- row for it — no consent, no email. Sign-up is open and every new workspace
-- makes its creator an Admin, so anyone who knew an address could do it, to
-- anyone, including a workspace's only Admin. Reactivating a user who had
-- since joined another workspace did the same thing.
--
-- The routes now compare case-insensitively and check by account id. This
-- index is the backstop: it makes a second active membership impossible to
-- write, whichever path tries, including two requests racing.
--
-- Not yet verified against the live database. The block below refuses to
-- create the index while any account already has more than one active row,
-- and lists them. Resolve those first — deactivate the membership the person
-- should not be in (usually the one created most recently) — then re-run.
-- To look before running:
--
--   select "authUserId", "tenantId", email, "createdAt" from tenant_users
--   where "isActive" and "authUserId" in (
--     select "authUserId" from tenant_users where "isActive"
--     group by 1 having count(*) > 1)
--   order by 1, "createdAt";
--
-- Idempotent: once the index exists no account can hold two active rows, so
-- the check passes and CREATE ... IF NOT EXISTS is a no-op.

DO $$
DECLARE
  offenders TEXT;
BEGIN
  SELECT string_agg(format('%s (%s active)', "authUserId", n), ', ')
    INTO offenders
  FROM (
    SELECT "authUserId", count(*) AS n
    FROM "tenant_users"
    WHERE "isActive"
    GROUP BY "authUserId"
    HAVING count(*) > 1
  ) d;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'Accounts with more than one active membership must be resolved first: %', offenders
      USING HINT = 'Deactivate the membership each person should not be in, then re-run this migration.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_users_one_active_per_auth_user"
  ON "tenant_users" ("authUserId")
  WHERE "isActive";
