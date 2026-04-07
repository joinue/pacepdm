import { getCurrentTenantUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/db";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FolderOpen, FileText, ClipboardList, History } from "lucide-react";
import Link from "next/link";

export default async function DashboardPage() {
  const tenantUser = await getCurrentTenantUser();
  const tenantId = tenantUser.tenantId;
  const db = getServiceClient();

  const [
    { count: fileCount },
    { count: folderCount },
    { count: ecoCount },
    { count: checkedOutByMe },
    { data: recentActivity },
  ] = await Promise.all([
    db.from("files").select("*", { count: "exact", head: true }).eq("tenantId", tenantId),
    db.from("folders").select("*", { count: "exact", head: true }).eq("tenantId", tenantId),
    db.from("ecos").select("*", { count: "exact", head: true }).eq("tenantId", tenantId),
    db.from("files").select("*", { count: "exact", head: true }).eq("tenantId", tenantId).eq("isCheckedOut", true).eq("checkedOutById", tenantUser.id),
    db.from("audit_logs")
      .select("*, user:tenant_users!audit_logs_userId_fkey(fullName)")
      .eq("tenantId", tenantId)
      .order("createdAt", { ascending: false })
      .limit(10),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Dashboard</h2>
        <p className="text-muted-foreground">
          Welcome back, {tenantUser.fullName}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Link href="/vault">
          <Card className="hover:shadow-md transition-shadow cursor-pointer">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Files</CardTitle>
              <FileText className="w-4 h-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{fileCount ?? 0}</div>
            </CardContent>
          </Card>
        </Link>

        <Link href="/vault">
          <Card className="hover:shadow-md transition-shadow cursor-pointer">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Folders</CardTitle>
              <FolderOpen className="w-4 h-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{folderCount ?? 0}</div>
            </CardContent>
          </Card>
        </Link>

        <Link href="/ecos">
          <Card className="hover:shadow-md transition-shadow cursor-pointer">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">ECOs</CardTitle>
              <ClipboardList className="w-4 h-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{ecoCount ?? 0}</div>
            </CardContent>
          </Card>
        </Link>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">My Checked-Out Files</CardTitle>
            <History className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{checkedOutByMe ?? 0}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
          <CardDescription>Latest actions across the vault</CardDescription>
        </CardHeader>
        <CardContent>
          {!recentActivity || recentActivity.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No activity yet. Start by uploading files to the vault.
            </p>
          ) : (
            <div className="space-y-3">
              {recentActivity.map((log) => (
                <div key={log.id} className="flex items-center justify-between text-sm border-b pb-2 last:border-0">
                  <div>
                    <span className="font-medium">{log.user?.fullName ?? "System"}</span>{" "}
                    <span className="text-muted-foreground">{log.action}</span>{" "}
                    <span className="text-muted-foreground">{log.entityType}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(log.createdAt).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
