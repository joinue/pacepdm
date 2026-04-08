import { getCurrentTenantUser } from "@/lib/auth";
import { AppShell } from "@/components/layout/app-shell";
import { TenantProvider } from "@/components/providers/tenant-provider";
import { NotificationProvider } from "@/components/providers/notification-provider";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const tenantUser = await getCurrentTenantUser();

  return (
    <TenantProvider
      tenantUser={{
        id: tenantUser.id,
        fullName: tenantUser.fullName,
        email: tenantUser.email,
        tenantId: tenantUser.tenantId,
        tenantName: tenantUser.tenant.name,
        tenantSlug: tenantUser.tenant.slug,
        role: tenantUser.role.name,
        permissions: tenantUser.role.permissions as string[],
      }}
    >
      <NotificationProvider>
        <AppShell>{children}</AppShell>
      </NotificationProvider>
    </TenantProvider>
  );
}
