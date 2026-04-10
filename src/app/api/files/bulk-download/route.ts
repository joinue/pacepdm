import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { z, parseBody, nonEmptyString } from "@/lib/validation";
import { filterViewable, getFolderAccessScope } from "@/lib/folder-access";

const BulkDownloadSchema = z.object({
  fileIds: z.array(nonEmptyString)
    .min(1, "No files specified")
    .max(50, "Maximum 50 files per download"),
});

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const parsed = await parseBody(request, BulkDownloadSchema);
    if (!parsed.ok) return parsed.response;
    const { fileIds } = parsed.data;

    const db = getServiceClient();

    // Fetch files and their latest versions
    const { data: rawFiles } = await db
      .from("files")
      .select("id, name, currentVersion, tenantId, folderId")
      .in("id", fileIds)
      .eq("tenantId", tenantUser.tenantId);

    // Silently drop files in folders the user can't view. Same convention
    // as the search route — a user can't enumerate restricted files by
    // bulk-downloading a guessed ID set.
    const scope = await getFolderAccessScope(tenantUser);
    const files = filterViewable(scope, rawFiles || [], (f) => f.folderId);

    if (!files || files.length === 0) {
      return NextResponse.json({ error: "No files found" }, { status: 404 });
    }

    // Fetch the latest version's storageKey for each file
    const results: { name: string; url: string }[] = [];
    for (const file of files) {
      const { data: version } = await db
        .from("file_versions")
        .select("storageKey")
        .eq("fileId", file.id)
        .eq("version", file.currentVersion)
        .single();

      if (!version) continue;

      const { data: signed } = await db.storage
        .from("vault")
        .createSignedUrl(version.storageKey, 120);

      if (signed?.signedUrl) {
        results.push({ name: file.name, url: signed.signedUrl });
      }
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "file.bulk_download",
      entityType: "file",
      entityId: fileIds.join(","),
      details: { count: results.length },
    });

    return NextResponse.json({ files: results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to prepare download";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
