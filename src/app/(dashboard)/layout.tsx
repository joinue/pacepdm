import { getCurrentTenantUser } from "@/lib/auth";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { TenantProvider } from "@/components/providers/tenant-provider";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let tenantUser;
  try {
    tenantUser = await getCurrentTenantUser();
  } catch (error) {
    console.error("Failed to load tenant user:", error);
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/40">
        <div className="text-center space-y-4 max-w-md">
          <h1 className="text-2xl font-bold">Connection Error</h1>
          <p className="text-muted-foreground">
            Unable to connect to the database. Please try refreshing the page.
          </p>
          <p className="text-xs text-muted-foreground font-mono">
            {error instanceof Error ? error.message : "Unknown error"}
          </p>
        </div>
      </div>
    );
  }

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
