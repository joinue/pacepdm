import { withTenant, notFound } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { z, uuid } from "@/lib/validation";
import { buildPartPackage, buildPartZipStream, partZipFilename } from "@/lib/part-package";

/**
 * GET /api/parts/[partId]/zip
 *
 * Streams the part's released files plus a manifest.json — the same
 * package a supplier gets through a share link, for the internal user
 * who would rather attach it to an email than send a URL.
 *
 * The matching public endpoint is /api/public/share/[token]/zip, which
 * uses the share token as its auth instead.
 */

const ParamsSchema = z.object({ partId: uuid });

// `?includeWip=true` mirrors the share toggle, so an internal user emailing
// the package attaches the same bytes a share link would serve. Preliminary
// files are prefixed and a READ-ME-FIRST.txt is added either way — the
// warning does not depend on how the zip was fetched.
const QuerySchema = z.object({
  includeWip: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

export const GET = withTenant(
  { permission: PERMISSIONS.FILE_VIEW, params: ParamsSchema, query: QuerySchema },
  async ({ db, tenantUser, params, query }) => {
    const pkg = await buildPartPackage(
      // buildPartPackage takes a raw client and scopes every query by the
      // tenantId it is handed — the caller's own. Same contract as
      // captureBomSnapshot and getFileWhereUsed.
      db.unscoped("buildPartPackage takes a raw client and scopes by the tenantId passed in"),
      tenantUser.tenantId,
      params.partId,
      { includeWip: query.includeWip }
    );
    if (!pkg) throw notFound("Part not found");

    const stream = buildPartZipStream(
      pkg,
      db.unscoped("streaming signed storage URLs for the package resolved above")
    );

    return new Response(stream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${partZipFilename(pkg)}"`,
        // Zip streams have no reliable length up front and the response
        // cannot be replayed, so each download is fresh.
        "Cache-Control": "no-store",
      },
    });
  }
);
