import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { fileIds } = await request.json();
    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      return NextResponse.json({ error: "No files specified" }, { status: 400 });
    }
    if (fileIds.length > 50) {
      return NextResponse.json({ error: "Maximum 50 files per download" }, { status: 400 });
    }

    const db = getServiceClient();

    // Fetch files and their latest versions
    const { data: files } = await db
      .from("files")
      .select("id, name, currentVersion, tenantId")
      .in("id", fileIds)
      .eq("tenantId", tenantUser.tenantId);

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
  } catch {
    return NextResponse.json({ error: "Failed to prepare download" }, { status: 500 });
  }
}
