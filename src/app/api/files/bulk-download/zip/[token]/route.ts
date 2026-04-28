import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import {
  buildFilesZipStream,
  safeZipFilename,
  verifyDownloadToken,
} from "@/lib/vault-zip";

/**
 * GET /api/files/bulk-download/zip/[token]
 *
 * Streams a zip of the files referenced by a signed download token. The
 * token is minted by /api/files/bulk-download/prepare or
 * /api/folders/[folderId]/download/prepare, both of which authorize
 * tenant + folder-access before signing. This endpoint trusts the token's
 * contents and does not re-authorize — the signature is the auth.
 *
 * GET on purpose so the browser handles the download natively (native
 * progress bar, save dialog, no JS memory pressure). Using GET also lets
 * us trigger the download with `window.location.href = ...` from the
 * client without any service-worker plumbing.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const verification = verifyDownloadToken(token);
  if (!verification.ok) {
    const status = verification.reason === "expired" ? 410 : 401;
    return NextResponse.json({ error: verification.reason }, { status });
  }

  const { verified } = verification;
  const db = getServiceClient();

  // Best-effort audit: record that the download actually started. Don't
  // block the response on it — a failed audit is not worth a failed
  // download.
  void logAudit({
    tenantId: verified.tenantId,
    userId: verified.userId,
    action: "file.bulk_download_stream",
    entityType: "file",
    entityId: "bulk",
    details: { count: verified.entries.length },
  });

  const stream = buildFilesZipStream(verified.entries, db);
  return new Response(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${safeZipFilename(verified.zipName)}"`,
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
