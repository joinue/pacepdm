import { getServiceClient } from "@/lib/db";
import { getCurrentTenantUser } from "@/lib/auth";
import { SettingsClient } from "./settings-client";

export default async function SettingsPage() {
  const tenantUser = await getCurrentTenantUser();
  const db = getServiceClient();

  const { data: tenant } = await db
    .from("tenants")
    .select("settings")
    .eq("id", tenantUser.tenantId)
    .single();

  return (
    <SettingsClient
      tenantName={tenantUser.tenant.name}
      tenantSlug={tenantUser.tenant.slug}
      initialSettings={(tenant?.settings as Record<string, unknown>) ?? {}}
    />
  );
}
