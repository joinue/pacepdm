-- PACE PDM Migration 022: Custom Access Token hook — inject tenantId claim
--
-- This is step 1 of 2 in adding Row-Level Security. The next migration
-- (023) enables RLS on the browser-touched tables and adds SELECT
-- policies that read `tenantId` from the JWT. That only works if the
-- JWT actually carries the claim — which it doesn't today, because
-- tenant membership lives in the `tenant_users` table, not in auth.
--
-- What this migration does
-- ────────────────────────
--
-- Creates a plpgsql function `public.custom_access_token_hook(event jsonb)`
-- that Supabase Auth can run every time it issues or refreshes a JWT.
-- The function looks up the caller's active `tenant_users` row and
-- injects two namespaced claims into `app_metadata`:
--
--   app_metadata.tenantId       — the user's current tenant (FK → tenants.id)
--   app_metadata.tenantUserId   — the tenant_users.id (used by RLS on
--                                 per-user tables like notifications)
--
-- If the user has no active tenant_users row yet (e.g. mid-onboarding),
-- the function returns the event unchanged — login still succeeds, the
-- claims are just absent, and RLS policies in migration 023 will fail
-- closed (zero rows visible) until a tenant_users row exists. This is
-- the correct behavior: no tenant → no data, enforced at the DB.
--
-- Multi-tenancy note
-- ──────────────────
--
-- Today there is exactly one active tenant_users row per auth user, so
-- the function picks "the" row with LIMIT 1. When multi-tenancy lands,
-- the function will need to consult a "current tenant" value — either
-- another column on `tenant_users` ("isCurrent"), or a separate
-- `user_current_tenant` table that a tenant-switcher UI writes to and
-- that triggers a `supabase.auth.refreshSession()` on the client. The
-- shape of this migration (a hook reading from a table) doesn't
-- change; only the row-selection logic does.
--
-- Manual step after running this SQL
-- ──────────────────────────────────
--
-- Register the hook in the Supabase dashboard:
--   Authentication → Hooks → Custom Access Token → select
--   `public.custom_access_token_hook` → Enable.
--
-- Until you do that, the function exists but is never called. That
-- makes this migration safe to run alone — nothing in the app changes
-- until the hook is registered, and the follow-up migration 023 is
-- what actually relies on the claim. Verify by signing out, signing
-- back in, and pasting the access token into jwt.io — you should see
-- `app_metadata.tenantId` populated.
--
-- Security hardening
-- ──────────────────
--
--   1. SECURITY DEFINER — the function has to read from `tenant_users`,
--      which `supabase_auth_admin` (the role that invokes the hook)
--      does not have SELECT on. Running as the owner (postgres) lets
--      the lookup succeed. This is why we lock `search_path` below —
--      without it, a SECURITY DEFINER function is a classic search
--      path injection vector.
--
--   2. `SET search_path = ''` — forces every identifier inside the
--      function body to be schema-qualified ("public"."tenant_users"),
--      so an attacker who creates a `tenant_users` table in a schema
--      earlier in their search path cannot trick the function into
--      reading their table.
--
--   3. GRANT EXECUTE to `supabase_auth_admin` only. Other roles have
--      no reason to call this function, and REVOKE from PUBLIC closes
--      the default grant.
--
-- Run this in the Supabase SQL Editor. Idempotent.

-- ─── 1. The hook function ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_claims       jsonb;
  v_app_metadata jsonb;
  v_user_id      text;
  v_tenant_id    text;
  v_tenant_user  text;
BEGIN
  -- Pull the existing claims. Every invocation receives `event.claims`
  -- as a jsonb object; we mutate and put it back before returning.
  v_claims := event -> 'claims';

  -- `auth.uid()` isn't set inside the hook — the user's id comes in on
  -- the event itself.
  v_user_id := event ->> 'user_id';

  -- Look up the user's active tenant_users row. LIMIT 1 because the
  -- current app model is one-active-tenant-per-user; if that ever
  -- changes this is the single line to update.
  SELECT "tenantId", "id"
    INTO v_tenant_id, v_tenant_user
    FROM "public"."tenant_users"
    WHERE "authUserId" = v_user_id
      AND "isActive" = TRUE
    LIMIT 1;

  -- If the user has no tenant yet (onboarding), return the event
  -- untouched. The login succeeds; RLS will fail closed downstream.
  IF v_tenant_id IS NULL THEN
    RETURN event;
  END IF;

  -- Merge the claims into `app_metadata`. Supabase guarantees custom
  -- claims placed under `app_metadata` won't collide with Supabase's
  -- own reserved keys; `user_metadata` is user-writable and unsafe
  -- for security-relevant data.
  v_app_metadata := COALESCE(v_claims -> 'app_metadata', '{}'::jsonb);
  v_app_metadata := v_app_metadata
    || jsonb_build_object('tenantId', v_tenant_id)
    || jsonb_build_object('tenantUserId', v_tenant_user);

  v_claims := jsonb_set(v_claims, '{app_metadata}', v_app_metadata);

  RETURN jsonb_set(event, '{claims}', v_claims);
END;
$$;

-- ─── 2. Permissions ──────────────────────────────────────────────────────
--
-- By default, CREATE FUNCTION grants EXECUTE to PUBLIC. Revoke that and
-- grant only to `supabase_auth_admin`, the role the Auth service uses
-- when invoking the hook.

REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM authenticated, anon;
GRANT  EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;

-- The function reads `tenant_users` via SECURITY DEFINER, so the caller
-- role doesn't need SELECT on the table. But the owner (postgres) does,
-- which it already has by default.

COMMENT ON FUNCTION public.custom_access_token_hook(jsonb) IS
  'PACE PDM: injects tenantId and tenantUserId into JWT app_metadata. Register in Dashboard → Authentication → Hooks → Custom Access Token.';
