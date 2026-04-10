import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { notify, sideEffect } from "@/lib/notifications";
import { processMentions } from "@/lib/mentions";
import { v4 as uuid } from "uuid";
import { isSolidWorksFile, extractSolidWorksThumbnail } from "@/lib/thumbnail";

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
    if (!file.isCheckedOut) {
      return NextResponse.json({ error: "File is not checked out" }, { status: 409 });
    }
    if (file.checkedOutById !== tenantUser.id) {
      if (!hasPermission(permissions, "admin.settings")) {
        return NextResponse.json({ error: "File is checked out by another user" }, { status: 403 });
      }
    }

    const formData = await request.formData();
    const newFile = formData.get("file") as globalThis.File | null;
    const comment = formData.get("comment") as string | null;
    const now = new Date().toISOString();
    const newVersion = file.currentVersion + 1;

    if (newFile) {
      const storageKey = `${tenantUser.tenantId}/${file.folderId}/${Date.now()}-${newFile.name}`;
      const arrayBuffer = await newFile.arrayBuffer();
      const { error: uploadError } = await db.storage
        .from("vault")
        .upload(storageKey, arrayBuffer, { contentType: newFile.type, upsert: false });

      if (uploadError) {
        return NextResponse.json({ error: "Failed to upload file" }, { status: 500 });
      }

      // Re-extract thumbnail for SolidWorks files
      let thumbnailKey = file.thumbnailKey;
      if (isSolidWorksFile(newFile.name)) {
        try {
          const thumb = await extractSolidWorksThumbnail(arrayBuffer);
          if (thumb) {
            const thumbExt = thumb.mimeType === "image/jpeg" ? "jpg" : "png";
            thumbnailKey = `${tenantUser.tenantId}/thumbnails/${Date.now()}-${newFile.name}.${thumbExt}`;
            await db.storage.from("vault").upload(thumbnailKey, thumb.data, {
              contentType: thumb.mimeType,
              upsert: false,
            });
          }
        } catch (e) {
          console.error("Thumbnail extraction failed:", e);
        }
      }

      await db.from("file_versions").insert({
        id: uuid(),
        fileId,
        version: newVersion,
        revision: file.revision,
        storageKey,
        fileSize: newFile.size,
        uploadedById: tenantUser.id,
        comment,
        createdAt: now,
      });

      await db.from("files").update({
        currentVersion: newVersion,
        isCheckedOut: false,
        checkedOutById: null,
        checkedOutAt: null,
        updatedAt: now,
        thumbnailKey,
      }).eq("id", fileId);
    } else {
      await db.from("files").update({
        isCheckedOut: false,
        checkedOutById: null,
        checkedOutAt: null,
        updatedAt: now,
      }).eq("id", fileId);
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: newFile ? "file.checkin" : "file.undo_checkout",
      entityType: "file",
      entityId: fileId,
      details: { name: file.name, version: newFile ? newVersion : file.currentVersion },
    });

    // Process @mentions in check-in comment
    if (comment?.trim()) {
      await sideEffect(
        processMentions({
          tenantId: tenantUser.tenantId,
          mentionedById: tenantUser.id,
          mentionedByName: tenantUser.fullName,
          entityType: "file_version",
          entityId: fileId,
          comment: comment.trim(),
          link: `/vault?file=${fileId}`,
        }),
        `process mentions for file checkin ${fileId}`
      );
    }

    // If an admin checked in someone else's file, notify the original checker
    if (file.checkedOutById && file.checkedOutById !== tenantUser.id) {
      await sideEffect(
        notify({
          tenantId: tenantUser.tenantId,
          userIds: [file.checkedOutById],
          title: newFile ? "File checked in by admin" : "Checkout cancelled by admin",
          message: newFile
            ? `"${file.name}" was checked in by ${tenantUser.fullName}`
            : `Your checkout of "${file.name}" was cancelled by ${tenantUser.fullName}`,
          type: "checkout",
          link: `/vault?file=${fileId}`,
        }),
        `notify checkout owner about admin checkin of ${fileId}`
      );
    }

    return NextResponse.json({ success: true, version: newFile ? newVersion : file.currentVersion });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to check in file";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
