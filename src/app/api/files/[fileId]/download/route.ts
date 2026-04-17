import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { requireFileAccess } from "@/lib/folder-access-guards";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { fileId } = await params;
    const { searchParams } = new URL(request.url);
    const versionNum = searchParams.get("version");
    const db = getServiceClient();

    const { data: file } = await db.from("files").select("*").eq("id", fileId).single();
    if (!file || file.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const access = await requireFileAccess(tenantUser, file, "view");
    if (!access.ok) return access.response;

    const { data: version } = await db
      .from("file_versions")
      .select("*")
      .eq("fileId", fileId)
      .eq("version", versionNum ? parseInt(versionNum) : file.currentVersion)
      .single();

    if (!version) {
      return NextResponse.json({ error: "Version not found" }, { status: 404 });
    }

    const { data, error } = await db.storage
      .from("vault")
      .createSignedUrl(version.storageKey, 60);

    if (error || !data) {
      return NextResponse.json({ error: "Failed to generate download URL" }, { status: 500 });
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "file.download",
      entityType: "file",
      entityId: fileId,
      details: { name: file.name, version: version.version },
    });

    return NextResponse.json({ url: data.signedUrl });
  } catch (err) {
    console.error("GET /api/files/[fileId]/download failed:", err);
    return NextResponse.json({ error: "Failed to download file" }, { status: 500 });
  }
}
