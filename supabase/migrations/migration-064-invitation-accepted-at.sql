-- PACE PDM Migration 064: when an invitation was accepted
--
-- Closes "no resend invite" and the Users page telling admins that everyone
-- is fine.
--
-- POST /api/users/invite inserted the tenant_users row the moment the
-- invitation was sent, and nothing recorded whether the invitee ever set a
-- password. Two consequences:
--
--   1. The Users page showed an invitee who never clicked as "Active", with
--      "Joined" set to the day the email went out. When they said "I can't
--      get in", the admin's screen said they were already in.
--   2. When the link expired (Supabase's email OTP expiry, an hour by
--      default), inviting again hit the "already exists in this workspace"
--      check. The only way to reissue was Remove → Invite, which is not what
--      "ask your admin to resend" (the email's own footer) suggests.
--
-- `acceptedAt` is null from invitation until the invitee sets their password
-- on /accept-invite. While it is null the row shows as "Invited", the invite
-- route treats a second invitation as a resend, and a signed-in session that
-- resolves to the row is sent back to /accept-invite to finish. Members added
-- from an existing account, workspace creators, and SSO-provisioned members
-- are stamped at creation: their account already works.
--
-- Backfill: an existing row is accepted if its auth account has ever signed
-- in. Verifying an invite link counts as a sign-in, so someone who clicked
-- Continue and never set a password is backfilled as accepted; the worst case
-- is that they use "Forgot password", which is what they would have done
-- anyway. Accounts that never signed in stay null and show as Invited, which
-- is the truth.
--
-- Idempotent. Not verified against the live database.

ALTER TABLE "tenant_users"
  ADD COLUMN IF NOT EXISTS "acceptedAt" timestamptz;

UPDATE "tenant_users" tu
   SET "acceptedAt" = u.last_sign_in_at
  FROM auth.users u
 WHERE u.id::text = tu."authUserId"
   AND tu."acceptedAt" IS NULL
   AND u.last_sign_in_at IS NOT NULL;

-- ── Verification ────────────────────────────────────────────────────────
--
--   select count(*) filter (where "acceptedAt" is null) as pending,
--          count(*) filter (where "acceptedAt" is not null) as accepted
--     from tenant_users;
--
--   -- The pending rows should be exactly the people who never signed in:
--   select tu.email, tu."createdAt", u.last_sign_in_at
--     from tenant_users tu left join auth.users u on u.id::text = tu."authUserId"
--    where tu."acceptedAt" is null;
