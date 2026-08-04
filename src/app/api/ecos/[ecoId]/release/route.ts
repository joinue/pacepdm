import { withTenant, notFound } from "@/lib/api-route";
import { getReleaseForEco } from "@/lib/releases";
import { z, uuid } from "@/lib/validation";

/**
 * GET /api/ecos/[ecoId]/release
 *
 * Returns the release for a given ECO, or 404 if the ECO hasn't been
 * implemented yet. Used by the ECO detail page to surface a "View release"
 * link once implementation has happened.
 */

const ParamsSchema = z.object({ ecoId: uuid });

export const GET = withTenant({ params: ParamsSchema }, async ({ db, tenantUser, params }) => {
  const release = await getReleaseForEco(
    db.unscoped("releases helper takes a raw client and scopes by the tenantId passed in"),
    tenantUser.tenantId,
    params.ecoId
  );
  if (!release) throw notFound("No release for this ECO");
  return release;
});
