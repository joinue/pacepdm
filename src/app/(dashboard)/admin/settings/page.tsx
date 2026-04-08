import { getCurrentTenantUser } from "@/lib/auth";
import { SettingsClient } from "./settings-client";

export default async function SettingsPage() {
  const tenantUser = await getCurrentTenantUser();

  return (
    <SettingsClient
      tenantName={tenantUser.tenant.name}
      tenantSlug={tenantUser.tenant.slug}
    />
  );
}
