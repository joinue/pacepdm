import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getServiceClient } from "@/lib/db";
import { redirect } from "next/navigation";
import { jitProvisionSsoUser } from "@/lib/sso-jit";

// Re-export shared constants so existing imports from "@/lib/auth" still work
export { PERMISSIONS, hasPermission, DEFAULT_ROLES, DEFAULT_METADATA_FIELDS } from "@/lib/permissions";

export async function getSession() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export async function requireAuth() {
  const user = await getSession();
  if (!user) redirect("/login");
  return user;
}

export async function getCurrentTenantUser() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const tenantUser = await resolveTenantUser(user.id, user.email || null, user.user_metadata);
  if (!tenantUser) redirect("/onboarding");
  return tenantUser;
}

/**
 * API-safe version: returns null instead of calling redirect().
 * Use this in Route Handlers (try/catch) where redirect() would be caught.
 */
export async function getApiTenantUser() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  return resolveTenantUser(user.id, user.email || null, user.user_metadata);
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
    .select(`
      *,
      tenant:tenants(*),
      role:roles(*)
    `)
    .eq("authUserId", authUserId)
    .eq("isActive", true)
    .single();

  if (error || !tenantUser) return null;
  return tenantUser;
}
