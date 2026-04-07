import { getCurrentTenantUser } from "@/lib/auth";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { TenantProvider } from "@/components/providers/tenant-provider";

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
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <div className="flex flex-col flex-1 overflow-hidden">
          <Header />
          <main className="flex-1 overflow-y-auto p-6 bg-muted/30">
            {children}
          </main>
        </div>
      </div>
    </TenantProvider>
  );
}
