import { withTenant, notFound } from "@/lib/api-route";
import { getReleaseById } from "@/lib/releases";
import { z, uuid } from "@/lib/validation";

const ParamsSchema = z.object({ releaseId: uuid });

export const GET = withTenant({ params: ParamsSchema }, async ({ db, tenantUser, params }) => {
  // getReleaseById takes a raw client and scopes by the tenantId it is given,
  // which is the caller's own.
  const release = await getReleaseById(
    db.unscoped("releases helper takes a raw client and scopes by the tenantId passed in"),
    tenantUser.tenantId,
    params.releaseId
  );
  if (!release) throw notFound("Release not found");
  return release;
});
