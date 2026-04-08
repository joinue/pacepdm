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
      <div className="flex h-screen bg-background">
        <Sidebar />
        <div className="flex flex-col flex-1 min-w-0">
          <Header />
          <main className="flex-1 overflow-y-auto">
            <div className="m-2 ml-0 p-6 rounded-xl bg-card border border-border/50 min-h-full">
              {children}
            </div>
          </main>
        </div>
      </div>
    </TenantProvider>
  );
}
