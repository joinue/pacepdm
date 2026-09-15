import { withTenant, notFound } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { z, nonEmptyString } from "@/lib/validation";
import { getReleaseById, buildReleaseZipStream, releaseZipFilename } from "@/lib/releases";

/**
 * GET /api/releases/[releaseId]/zip
 *
 * Streams a zip of the release's files plus a manifest.json. Authenticated
 * only — the matching public endpoint lives at
 * /api/public/share/[token]/zip and uses the share token as its auth.
 */

// Next reads segment config statically; keep in step with
// ZIP_MAX_DURATION_SECONDS in src/lib/vault-zip.ts.
export const maxDuration = 300;

const ParamsSchema = z.object({ releaseId: nonEmptyString });

export const GET = withTenant(
  { permission: PERMISSIONS.FILE_VIEW, params: ParamsSchema },
  async ({ db, tenantUser, params }) => {
    const release = await getReleaseById(
      // getReleaseById takes a raw client and filters by the tenantId it is
      // handed — the caller's own.
      db.unscoped("getReleaseById takes a raw client and scopes by the tenantId passed in"),
      tenantUser.tenantId,
      params.releaseId
    );
    if (!release) throw notFound("Release not found");

    return new Response(buildReleaseZipStream(release, db), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${releaseZipFilename(release)}"`,
        // Zip streams have no reliable length up front and we can't reuse
        // the response, so disable caching. Each download is fresh.
        "Cache-Control": "no-store",
      },
    });
  }
);
