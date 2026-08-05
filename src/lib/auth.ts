import { cache } from "react";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getServiceClient } from "@/lib/db";
import { redirect } from "next/navigation";
import { jitProvisionSsoUser } from "@/lib/sso-jit";

// Re-export shared constants so existing imports from "@/lib/auth" still work
export {
  PERMISSIONS,
  hasPermission,
  permissionsExceedingActor,
  DEFAULT_ROLES,
  DEFAULT_METADATA_FIELDS,
} from "@/lib/permissions";

/**
 * Resolving the caller costs two network round-trips: `auth.getUser()` hits
 * the Supabase Auth server (it validates the JWT remotely, it does not decode
 * it locally), and `findTenantUser` joins tenants and roles.
 *
 * Both the dashboard layout and the page beneath it need the caller, so an
 * uncached implementation paid that twice before rendering a single byte.
 * `cache()` scopes memoisation to the current request, so every call after
 * the first in one render pass — layout, page, and any component that asks
 * again — is free. Nothing is shared across requests or users.
 */
const loadAuthUser = cache(async () => {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

/**
 * Why a status union rather than `TenantUser | null`: the two failure modes
 * redirect to different places (`/login` vs `/onboarding`), so collapsing
 * them into null would lose the information the caller needs. Keeping one
 * cached resolver — instead of one per public entry point — is what makes
 * the memoisation actually hit.
 */
type TenantUserResult =
  | { status: "ok"; tenantUser: NonNullable<Awaited<ReturnType<typeof findTenantUser>>> }
  | { status: "unauthenticated" }
  | { status: "no-tenant" };

const loadTenantUser = cache(async (): Promise<TenantUserResult> => {
  const user = await loadAuthUser();
  if (!user) return { status: "unauthenticated" };

  const tenantUser = await resolveTenantUser(user.id, user.email || null, user.user_metadata);
  if (!tenantUser) return { status: "no-tenant" };

  return { status: "ok", tenantUser };
});

export async function getSession() {
  return loadAuthUser();
}

export async function requireAuth() {
  const user = await loadAuthUser();
  if (!user) redirect("/login");
  return user;
}

export async function getCurrentTenantUser() {
  const result = await loadTenantUser();
  if (result.status === "unauthenticated") redirect("/login");
  if (result.status === "no-tenant") redirect("/onboarding");
  return result.tenantUser;
}

/**
 * API-safe version: returns null instead of calling redirect().
 * Use this in Route Handlers (try/catch) where redirect() would be caught.
 */
export async function getApiTenantUser() {
  const result = await loadTenantUser();
  return result.status === "ok" ? result.tenantUser : null;
}

/**
 * Find the tenant_users row for the currently authenticated Supabase user.
 * If none exists and the user's email domain matches a tenant_sso_domains
 * entry, JIT-provision a row in that tenant. An existing row always wins
 * (block semantics: we do not migrate users across tenants).
 */
async function resolveTenantUser(
  authUserId: string,
  email: string | null,
  metadata: Record<string, unknown> | undefined
) {
  const existing = await findTenantUser(authUserId);
  if (existing) return existing;

  if (!email) return null;

  // No row yet — try JIT provisioning via SSO domain mapping.
  const provisioned = await jitProvisionSsoUser({
    authUserId,
    email,
    metadata,
  });
  if (!provisioned) return null;

  return findTenantUser(authUserId);
}

async function findTenantUser(authUserId: string) {
  const db = getServiceClient();
  const { data: tenantUser, error } = await db
    .from("tenant_users")
    .select(
      `
      *,
      tenant:tenants(*),
      role:roles(*)
    `
    )
    .eq("authUserId", authUserId)
    .eq("isActive", true)
    .single();

  if (error || !tenantUser) return null;
  return tenantUser;
}
