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
import { Badge } from "@/components/ui/badge";

export default async function MetadataFieldsPage() {
  const tenantUser = await getCurrentTenantUser();

  const fields = await prisma.metadataField.findMany({
    where: { tenantId: tenantUser.tenantId },
    orderBy: { sortOrder: "asc" },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Metadata Fields</h2>
      </div>

      <div className="border rounded-lg bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Required</TableHead>
              <TableHead>Options</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {fields.map((field) => (
              <TableRow key={field.id}>
                <TableCell className="font-medium">
                  {field.name}
                  {field.isSystem && (
                    <Badge variant="secondary" className="ml-2 text-xs">
                      System
                    </Badge>
                  )}
                </TableCell>
                <TableCell>{field.fieldType}</TableCell>
                <TableCell>{field.isRequired ? "Yes" : "No"}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {field.options
                    ? (field.options as string[]).join(", ")
                    : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
