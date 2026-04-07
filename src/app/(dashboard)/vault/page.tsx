import { prisma } from "@/lib/prisma";
import { getCurrentTenantUser } from "@/lib/auth";
import { VaultBrowser } from "@/components/vault/vault-browser";

export default async function VaultPage() {
  const tenantUser = await getCurrentTenantUser();

  // Get root folder
  const rootFolder = await prisma.folder.findFirst({
    where: {
      tenantId: tenantUser.tenantId,
      parentId: null,
    },
  });

  // Get metadata fields for this tenant
  const metadataFields = await prisma.metadataField.findMany({
    where: { tenantId: tenantUser.tenantId },
    orderBy: { sortOrder: "asc" },
  });

  return (
    <VaultBrowser
      rootFolderId={rootFolder?.id ?? ""}
      metadataFields={metadataFields.map((f) => ({
        id: f.id,
        name: f.name,
        fieldType: f.fieldType,
        options: f.options as string[] | null,
        isRequired: f.isRequired,
      }))}
    />
  );
}
