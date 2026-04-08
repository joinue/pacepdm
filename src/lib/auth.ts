import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getServiceClient } from "@/lib/db";
import { redirect } from "next/navigation";

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
  const user = await requireAuth();
  const tenantUser = await findTenantUser(user.id);
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
  return findTenantUser(user.id);
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
