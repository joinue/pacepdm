import { getServiceClient } from "@/lib/db";
import { getCurrentTenantUser } from "@/lib/auth";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export default async function UsersPage() {
  const tenantUser = await getCurrentTenantUser();
  const db = getServiceClient();

  const { data: users } = await db
    .from("tenant_users")
    .select("*, role:roles!tenant_users_roleId_fkey(name)")
    .eq("tenantId", tenantUser.tenantId)
    .order("createdAt");

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Users</h2>
      <div className="border rounded-lg bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Joined</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(users || []).map((user) => (
              <TableRow key={user.id}>
                <TableCell className="font-medium">{user.fullName}</TableCell>
                <TableCell>{user.email}</TableCell>
                <TableCell><Badge variant="secondary">{user.role?.name}</Badge></TableCell>
                <TableCell><Badge variant={user.isActive ? "default" : "destructive"}>{user.isActive ? "Active" : "Inactive"}</Badge></TableCell>
                <TableCell className="text-sm text-muted-foreground">{new Date(user.createdAt).toLocaleDateString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
