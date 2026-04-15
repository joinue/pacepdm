import { notFound } from "next/navigation";
import { getServiceClient } from "@/lib/db";
import { getCurrentTenantUser } from "@/lib/auth";
import { getReleaseById } from "@/lib/releases";
import { ReleasePageClient } from "./release-page-client";

export default async function ReleasePage({
  params,
}: {
  params: Promise<{ releaseId: string }>;
}) {
  const tenantUser = await getCurrentTenantUser();
  const db = getServiceClient();
  const { releaseId } = await params;
  const release = await getReleaseById(db, tenantUser.tenantId, releaseId);
  if (!release) notFound();

  return <ReleasePageClient release={release} />;
}
