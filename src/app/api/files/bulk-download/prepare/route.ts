import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { z, parseBody, nonEmptyString } from "@/lib/validation";
import { getFolderAccessScope } from "@/lib/folder-access";
import {
  resolveFilesToEntries,
  signDownloadToken,
  MAX_DOWNLOAD_BYTES,
} from "@/lib/vault-zip";

const PrepareSchema = z.object({
  // No upper bound on count — the server-side stream is memory-bounded.
  // Total byte size is what we actually guard against, downstream.
  fileIds: z.array(nonEmptyString).min(1, "No files specified"),
});

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const parsed = await parseBody(request, PrepareSchema);
    if (!parsed.ok) return parsed.response;
    const { fileIds } = parsed.data;

    const db = getServiceClient();
    const scope = await getFolderAccessScope(tenantUser);
    const { entries, totalBytes } = await resolveFilesToEntries(
      db,
      tenantUser.tenantId,
      fileIds,
      scope
    );

    if (entries.length === 0) {
      return NextResponse.json({ error: "No accessible files in selection" }, { status: 404 });
    }

    if (totalBytes > MAX_DOWNLOAD_BYTES) {
      return NextResponse.json(
        {
          error: "Download too large",
          totalBytes,
          maxBytes: MAX_DOWNLOAD_BYTES,
        },
        { status: 413 }
      );
    }

    const token = signDownloadToken({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      entries,
      zipName: `vault-${new Date().toISOString().slice(0, 10)}`,
    });

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "file.bulk_download_prepare",
      entityType: "file",
      entityId: fileIds.slice(0, 20).join(","),
      details: { count: entries.length, totalBytes },
    });

    return NextResponse.json({
      token,
      count: entries.length,
      totalBytes,
    });
  } catch (err) {
    console.error("Failed to prepare bulk download:", err);
    const message = err instanceof Error ? err.message : "Failed to prepare download";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
