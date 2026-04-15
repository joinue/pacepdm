import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";
import {
  getReleaseById,
  buildReleaseZipStream,
  releaseZipFilename,
} from "@/lib/releases";

/**
 * GET /api/releases/[releaseId]/zip
 *
 * Streams a zip of the release's files plus a manifest.json. Authenticated
 * only — the matching public endpoint lives at
 * /api/public/share/[token]/zip and uses the share token as its auth.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ releaseId: string }> }
) {
  const tenantUser = await getApiTenantUser();
  if (!tenantUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { releaseId } = await params;
  const db = getServiceClient();
  const release = await getReleaseById(db, tenantUser.tenantId, releaseId);
  if (!release) {
    return NextResponse.json({ error: "Release not found" }, { status: 404 });
  }

  const stream = buildReleaseZipStream(release, db);
  return new Response(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${releaseZipFilename(release)}"`,
      // Zip streams have no reliable length up front and we can't reuse
      // the response, so disable caching. Each download is fresh.
      "Cache-Control": "no-store",
    },
  });
}
