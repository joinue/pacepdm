import { getCurrentTenantUser } from "@/lib/auth";

export default async function ECOsPage() {
  await getCurrentTenantUser();

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Engineering Change Orders</h2>
      <div className="border rounded-lg bg-background p-8 text-center text-muted-foreground">
        <p className="text-lg font-medium">Coming in Phase 2</p>
        <p className="mt-2">
          ECO creation, approval workflows, and change tracking will be
          available here.
        </p>
      </div>
    </div>
  );
}
