import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { getFolderAccessScope } from "@/lib/folder-access";
import {
  resolveFolderToEntries,
  signDownloadToken,
  MAX_DOWNLOAD_BYTES,
} from "@/lib/vault-zip";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ folderId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { folderId } = await params;
    if (!folderId) return NextResponse.json({ error: "Missing folderId" }, { status: 400 });

    const db = getServiceClient();
    const scope = await getFolderAccessScope(tenantUser);
    const result = await resolveFolderToEntries(db, tenantUser.tenantId, folderId, scope);

    if (!result.ok) {
      const status = result.reason === "not_found" ? 404 : 403;
      return NextResponse.json({ error: result.reason }, { status });
    }

    if (result.entries.length === 0) {
      return NextResponse.json({ error: "Folder has no downloadable files" }, { status: 404 });
    }

    if (result.totalBytes > MAX_DOWNLOAD_BYTES) {
      return NextResponse.json(
        {
          error: "Download too large",
          totalBytes: result.totalBytes,
          maxBytes: MAX_DOWNLOAD_BYTES,
        },
        { status: 413 }
      );
    }

    const token = signDownloadToken({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      entries: result.entries,
      zipName: result.rootName,
    });

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "folder.download_prepare",
      entityType: "folder",
      entityId: folderId,
      details: {
        count: result.entries.length,
        totalBytes: result.totalBytes,
        rootName: result.rootName,
      },
    });

    return NextResponse.json({
      token,
      count: result.entries.length,
      totalBytes: result.totalBytes,
      rootName: result.rootName,
    });
  } catch (err) {
    console.error("Failed to prepare folder download:", err);
    const message = err instanceof Error ? err.message : "Failed to prepare download";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
