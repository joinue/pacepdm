import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { extractThumbnail } from "@/lib/thumbnail";
import { requireFileAccess } from "@/lib/folder-access-guards";
import { v4 as uuid } from "uuid";

/**
 * Atomic "upload new version" — performs checkout + checkin in a single
 * request so the file is never left in a dangling checked-out state.
 * Used by the upload dialog's duplicate-file resolution flow.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    const { fileId } = await params;

    if (!hasPermission(permissions, PERMISSIONS.FILE_UPLOAD)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const db = getServiceClient();

    const { data: file } = await db.from("files").select("*").eq("id", fileId).single();
    if (!file || file.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const access = await requireFileAccess(tenantUser, file, "edit");
    if (!access.ok) return access.response;

    if (file.isFrozen) {
      return NextResponse.json(
        { error: "Cannot create a new version of a released/frozen file. Revise it first." },
        { status: 409 }
      );
    }

    if (file.isCheckedOut && file.checkedOutById !== tenantUser.id) {
      return NextResponse.json(
        { error: "File is checked out by another user" },
        { status: 409 }
      );
    }

    const formData = await request.formData();
    const newFile = formData.get("file") as globalThis.File | null;
    const comment = formData.get("comment") as string | null;

    if (!newFile) {
      return NextResponse.json({ error: "File is required" }, { status: 400 });
    }

    if (newFile.size > 5 * 1024 * 1024 * 1024) {
      return NextResponse.json({ error: "File exceeds the 5 GB size limit" }, { status: 413 });
    }

    const now = new Date().toISOString();
    const newVersion = file.currentVersion + 1;

    // Upload to storage
    const storageKey = `${tenantUser.tenantId}/${file.folderId}/${Date.now()}-${newFile.name}`;
    const arrayBuffer = await newFile.arrayBuffer();
    const { error: uploadError } = await db.storage
      .from("vault")
      .upload(storageKey, arrayBuffer, { contentType: newFile.type, upsert: false });

    if (uploadError) {
      console.error("Upload error:", uploadError);
      return NextResponse.json({ error: "Failed to upload file" }, { status: 500 });
    }

    // Regenerate thumbnail
    let thumbnailKey = file.thumbnailKey;
    let thumbnailWarning: string | null = null;
    try {
      const thumb = await extractThumbnail(arrayBuffer, newFile.name);
      if (thumb) {
        thumbnailKey = `${tenantUser.tenantId}/thumbnails/${Date.now()}-${newFile.name}.${thumb.ext}`;
        await db.storage.from("vault").upload(thumbnailKey, thumb.data, {
          contentType: thumb.mimeType,
          upsert: false,
        });
      }
    } catch (e) {
      console.error("Thumbnail generation failed:", e);
      thumbnailWarning = "Thumbnail could not be generated — you can upload one manually from the file detail panel.";
    }

    // Create version record
    await db.from("file_versions").insert({
      id: uuid(),
      fileId,
      version: newVersion,
      revision: file.revision,
      storageKey,
      fileSize: newFile.size,
      uploadedById: tenantUser.id,
      comment: comment || `New version uploaded (replaced duplicate)`,
      createdAt: now,
    });

    // Update file record — clear any checkout and bump version
    await db.from("files").update({
      currentVersion: newVersion,
      isCheckedOut: false,
      checkedOutById: null,
      checkedOutAt: null,
      updatedAt: now,
      thumbnailKey,
    }).eq("id", fileId);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "file.upload_version",
      entityType: "file",
      entityId: fileId,
      details: { name: file.name, version: newVersion, size: newFile.size },
    });

    const warnings = thumbnailWarning ? [thumbnailWarning] : undefined;
    return NextResponse.json({ success: true, version: newVersion, warnings });
  } catch (err) {
    console.error("POST /api/files/[fileId]/upload-version failed:", err);
    const message = err instanceof Error ? err.message : "Failed to upload new version";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
