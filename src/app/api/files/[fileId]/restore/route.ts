import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { v4 as uuid } from "uuid";
import { z, parseBody } from "@/lib/validation";
import { requireFileAccess } from "@/lib/folder-access-guards";

const RestoreSchema = z.object({
  version: z.number().int().positive(),
});

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
    if (!file || file.tenantId !== tenantUser.tenantId || file.deletedAt) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const access = await requireFileAccess(tenantUser, file, "edit");
    if (!access.ok) return access.response;

    if (file.isCheckedOut) {
      return NextResponse.json(
        { error: "Cannot restore while file is checked out" },
        { status: 409 }
      );
    }
    if (file.isFrozen) {
      return NextResponse.json(
        { error: "Cannot restore a frozen file. Use Change State first." },
        { status: 409 }
      );
    }

    const parsed = await parseBody(request, RestoreSchema);
    if (!parsed.ok) return parsed.response;
    const targetVersion = parsed.data.version;

    if (targetVersion >= file.currentVersion) {
      return NextResponse.json(
        { error: "Cannot restore current or future version" },
        { status: 400 }
      );
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

    const { error: versionError } = await db.from("file_versions").insert({
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

    // Refuse before bumping the file. A restore that failed here but bumped
    // anyway would leave the file claiming a version nothing wrote — and this
    // is the recovery path, so it is the last place that should invent a new
    // way to lose a version.
    if (versionError) {
      return NextResponse.json(
        { error: `Could not create the restored version: ${versionError.message}` },
        { status: 500 }
      );
    }

    // Refuse before the audit row. A restore that reports success without
    // moving `currentVersion` leaves the file on the version the user was
    // trying to replace, and an audit entry saying otherwise.
    const { error: bumpError } = await db
      .from("files")
      .update({
        currentVersion: newVersion,
        updatedAt: now,
        thumbnailKey: file.thumbnailKey, // keep current thumbnail
      })
      .eq("id", fileId);
    if (bumpError) {
      return NextResponse.json(
        { error: `The restored version was created but not made current: ${bumpError.message}` },
        { status: 500 }
      );
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "file.restore",
      entityType: "file",
      entityId: fileId,
      details: { name: file.name, fromVersion: targetVersion, newVersion },
    });

    return NextResponse.json({ success: true, newVersion });
  } catch (err) {
    console.error("Failed to restore version:", err);
    const message = err instanceof Error ? err.message : "Failed to restore version";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
