import { getServiceClient } from "@/lib/db";
import { getCurrentTenantUser } from "@/lib/auth";
import { MetadataClient } from "./metadata-client";

export default async function MetadataFieldsPage() {
  const tenantUser = await getCurrentTenantUser();
  const db = getServiceClient();

  const { data: fields } = await db
    .from("metadata_fields")
    .select("*")
    .eq("tenantId", tenantUser.tenantId)
    .order("sortOrder");

  return <MetadataClient fields={fields || []} />;
}
