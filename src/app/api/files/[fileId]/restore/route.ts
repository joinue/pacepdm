import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { v4 as uuid } from "uuid";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    const { fileId } = await params;

    if (!hasPermission(permissions, PERMISSIONS.FILE_CHECKIN)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const db = getServiceClient();
    const { data: file } = await db.from("files").select("*").eq("id", fileId).single();
    if (!file || file.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    if (file.isCheckedOut) {
      return NextResponse.json({ error: "Cannot restore while file is checked out" }, { status: 409 });
    }
    if (file.isFrozen) {
      return NextResponse.json({ error: "Cannot restore a frozen file. Use Change State first." }, { status: 409 });
    }

    const body = await request.json();
    const targetVersion = body.version as number;
    if (!targetVersion || targetVersion >= file.currentVersion) {
      return NextResponse.json({ error: "Invalid version" }, { status: 400 });
    }

    // Fetch the version to restore
    const { data: sourceVersion } = await db
      .from("file_versions")
      .select("*")
      .eq("fileId", fileId)
      .eq("version", targetVersion)
      .single();

    if (!sourceVersion) {
      return NextResponse.json({ error: "Version not found" }, { status: 404 });
    }

    // Create a new version entry that points to the same storage key as the old version
    const newVersion = file.currentVersion + 1;
    const now = new Date().toISOString();

    await db.from("file_versions").insert({
      id: uuid(),
      fileId,
      version: newVersion,
      revision: file.revision,
      storageKey: sourceVersion.storageKey,
      fileSize: sourceVersion.fileSize,
      uploadedById: tenantUser.id,
      comment: `Restored from version ${targetVersion}`,
      createdAt: now,
    });

    await db.from("files").update({
      currentVersion: newVersion,
      updatedAt: now,
      thumbnailKey: file.thumbnailKey, // keep current thumbnail
    }).eq("id", fileId);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "file.restore",
      entityType: "file",
      entityId: fileId,
      details: { name: file.name, fromVersion: targetVersion, newVersion },
    });

    return NextResponse.json({ success: true, newVersion });
  } catch {
    return NextResponse.json({ error: "Failed to restore version" }, { status: 500 });
  }
}
