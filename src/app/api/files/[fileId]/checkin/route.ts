import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { notify, sideEffect } from "@/lib/notifications";
import { processMentions } from "@/lib/mentions";
import { v4 as uuid } from "uuid";
import { extractThumbnail } from "@/lib/thumbnail";
import { requireFileAccess } from "@/lib/folder-access-guards";

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

    const access = await requireFileAccess(tenantUser, file, "edit");
    if (!access.ok) return access.response;

    if (!file.isCheckedOut) {
      return NextResponse.json({ error: "File is not checked out" }, { status: 409 });
    }
    if (file.checkedOutById !== tenantUser.id) {
      if (!hasPermission(permissions, "admin.settings")) {
        return NextResponse.json({ error: "File is checked out by another user" }, { status: 403 });
      }
    }
    // Defense in depth: refuse to commit a new version if the file
    // froze during the checkout window. In normal flow `isCheckedOut`
    // and `isFrozen` are mutually exclusive (transition routes refuse
    // checked-out files, checkout refuses frozen files), but a buggy
    // path or direct DB write could still land us here. The released
    // artifact stays immutable.
    if (file.isFrozen) {
      return NextResponse.json({ error: "Cannot check in a frozen/released file. The release happened during your checkout — undo your checkout instead." }, { status: 409 });
    }

    const formData = await request.formData();
    const newFile = formData.get("file") as globalThis.File | null;
    const comment = formData.get("comment") as string | null;
    const now = new Date().toISOString();
    const newVersion = file.currentVersion + 1;

    if (newFile && newFile.size > 5 * 1024 * 1024 * 1024) {
      return NextResponse.json({ error: "File exceeds the 5 GB size limit" }, { status: 413 });
    }

    let thumbnailWarning: string | null = null;

    if (newFile) {
      const storageKey = `${tenantUser.tenantId}/${file.folderId}/${Date.now()}-${newFile.name}`;
      const arrayBuffer = await newFile.arrayBuffer();
      const { error: uploadError } = await db.storage
        .from("vault")
        .upload(storageKey, arrayBuffer, { contentType: newFile.type, upsert: false });

      if (uploadError) {
        return NextResponse.json({ error: "Failed to upload file" }, { status: 500 });
      }

      // Regenerate the thumbnail via the format dispatcher. Keeps the old
      // key on failure so the file list still has *something* to show; the
      // dispatcher returns null for unsupported formats, which is fine.
      // Clone the buffer — the storage upload above may have consumed it.
      let thumbnailKey = file.thumbnailKey;
      try {
        const thumbBuffer = arrayBuffer.slice(0);
        const thumb = await extractThumbnail(thumbBuffer, newFile.name);
        if (thumb) {
          const key = `${tenantUser.tenantId}/thumbnails/${Date.now()}-${newFile.name}.${thumb.ext}`;
          const { error: thumbUploadError } = await db.storage.from("vault").upload(key, thumb.data, {
            contentType: thumb.mimeType,
            upsert: false,
          });
          if (thumbUploadError) {
            console.error("Thumbnail storage upload failed:", thumbUploadError);
            thumbnailWarning = "Thumbnail was generated but could not be saved — you can upload one manually from the file detail panel.";
          } else {
            thumbnailKey = key;
          }
        }
      } catch (e) {
        console.error("Thumbnail generation failed:", e);
        thumbnailWarning = "Thumbnail could not be generated — you can upload one manually from the file detail panel.";
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

    // If an admin checked in someone else's file, notify the original
    // checker. notify() filters the actor, so the self-checkin case is
    // a no-op.
    if (file.checkedOutById) {
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
          refId: fileId,
          actorId: tenantUser.id,
        }),
        `notify checkout owner about admin checkin of ${fileId}`
      );
    }

    const warnings = (newFile && thumbnailWarning) ? [thumbnailWarning] : undefined;
    return NextResponse.json({ success: true, version: newFile ? newVersion : file.currentVersion, warnings });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to check in file";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
