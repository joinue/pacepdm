import { getServiceClient } from "@/lib/db";
import { getCurrentTenantUser } from "@/lib/auth";
import { VaultBrowser } from "@/components/vault/vault-browser";

export default async function VaultPage() {
  const tenantUser = await getCurrentTenantUser();
  const db = getServiceClient();

  const { data: rootFolder } = await db
    .from("folders")
    .select("id")
    .eq("tenantId", tenantUser.tenantId)
    .is("parentId", null)
    .single();

  const { data: metadataFields } = await db
    .from("metadata_fields")
    .select("id, name, fieldType, options, isRequired")
    .eq("tenantId", tenantUser.tenantId)
    .order("sortOrder");

  return (
    <VaultBrowser
      rootFolderId={rootFolder?.id ?? ""}
      metadataFields={(metadataFields || []).map((f) => ({
        id: f.id,
        name: f.name,
        fieldType: f.fieldType,
        options: f.options as string[] | null,
        isRequired: f.isRequired,
      }))}
    />
  );
}
