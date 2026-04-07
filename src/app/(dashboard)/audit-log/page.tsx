import { prisma } from "@/lib/prisma";
import { getCurrentTenantUser } from "@/lib/auth";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default async function AuditLogPage() {
  const tenantUser = await getCurrentTenantUser();

  const logs = await prisma.auditLog.findMany({
    where: { tenantId: tenantUser.tenantId },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      user: { select: { fullName: true, email: true } },
    },
  });

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Audit Log</h2>

      <div className="border rounded-lg bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Timestamp</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Entity Type</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center py-8 text-muted-foreground"
                >
                  No activity recorded yet.
                </TableCell>
              </TableRow>
            ) : (
              logs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="text-sm">
                    {new Date(log.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    {log.user?.fullName ?? "System"}
                  </TableCell>
                  <TableCell className="font-mono text-sm">
                    {log.action}
                  </TableCell>
                  <TableCell>{log.entityType}</TableCell>
                  <TableCell className="text-sm text-muted-foreground max-w-xs truncate">
                    {log.details
                      ? JSON.stringify(log.details)
                      : "—"}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
