import { NextResponse } from "next/server";
import { withPublicRoute } from "@/lib/api-route";
import {
  resolveToken,
  unlockCookieName,
  verifyUnlockCookie,
  bumpAccessCount,
  logShareAccess,
} from "@/lib/share-tokens";
import { enforceRateLimit, getClientIp } from "@/lib/rate-limit";
import {
  getReleaseById,
  buildReleaseZipStream,
  releaseZipFilename,
} from "@/lib/releases";
import { buildPartPackage, buildPartZipStream, partZipFilename } from "@/lib/part-package";

/**
 * GET /api/public/share/[token]/zip
 *
 * Public zip download for a release or a part wrapped in a share link.
 * Same auth rules for both: token must resolve, password cookie must be
 * valid if the token has one, and the share must have
 * `allowDownload: true`.
 *
 * File and BOM shares have no zip — a file share already hands over the
 * one file, and a BOM share is a table with no attachments.
 */

// Next reads segment config statically; keep in step with
// ZIP_MAX_DURATION_SECONDS in src/lib/vault-zip.ts.
export const maxDuration = 300;

const NO_INDEX = { "X-Robots-Tag": "noindex, nofollow" };

export const GET = withPublicRoute({}, async ({ request, params, db }) => {
  const limited = enforceRateLimit(request, "share-zip");
  if (limited) return limited;

  const { token } = params;
  const result = await resolveToken(token);
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 404, headers: NO_INDEX });
  }
  const row = result.token;
  if (row.resourceType !== "release" && row.resourceType !== "part") {
    return NextResponse.json(
      { error: "Zip download is only available for release and part share links" },
      { status: 400, headers: NO_INDEX }
    );
  }
  if (!row.allowDownload) {
    return NextResponse.json(
      { error: "Download not allowed for this share link" },
      { status: 403, headers: NO_INDEX }
    );
  }
  if (row.passwordHash) {
    const cookie = request.cookies.get(unlockCookieName(token))?.value;
    if (!verifyUnlockCookie(token, cookie)) {
      return NextResponse.json({ error: "password_required" }, { status: 401, headers: NO_INDEX });
    }
  }

  // Resolve the target first, then log — a 404 should not record a
  // successful zip-download against the token.
  let stream: ReadableStream<Uint8Array>;
  let filename: string;

  if (row.resourceType === "part") {
    const pkg = await buildPartPackage(db, row.tenantId, row.resourceId, {
      includeWip: row.includeWip,
    });
    if (!pkg) {
      return NextResponse.json({ error: "Part not found" }, { status: 404, headers: NO_INDEX });
    }
    stream = buildPartZipStream(pkg, db);
    filename = partZipFilename(pkg);
  } else {
    const release = await getReleaseById(db, row.tenantId, row.resourceId);
    if (!release) {
      return NextResponse.json({ error: "Release not found" }, { status: 404, headers: NO_INDEX });
    }
    stream = buildReleaseZipStream(release, db);
    filename = releaseZipFilename(release);
  }

  void bumpAccessCount(row.id);
  logShareAccess({
    tenantId: row.tenantId,
    tokenId: row.id,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    action: "zip-download",
    ipAddress: getClientIp(request),
    userAgent: request.headers.get("user-agent"),
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      ...NO_INDEX,
    },
  });
});
