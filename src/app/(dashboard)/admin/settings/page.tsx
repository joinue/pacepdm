import { getCurrentTenantUser } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function SettingsPage() {
  const tenantUser = await getCurrentTenantUser();

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Settings</h2>
      <Card>
        <CardHeader>
          <CardTitle>Workspace</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Company Name</span>
            <span className="font-medium">{tenantUser.tenant.name}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Slug</span>
            <span className="font-mono">{tenantUser.tenant.slug}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
