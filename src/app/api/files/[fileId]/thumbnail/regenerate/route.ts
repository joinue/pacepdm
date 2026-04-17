import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { extractThumbnail } from "@/lib/thumbnail";
import { requireFileAccess } from "@/lib/folder-access-guards";

/**
 * POST /api/files/[fileId]/thumbnail/regenerate
 *
 * Re-runs the thumbnail extraction pipeline against a file that's
 * already in storage and updates `files.thumbnailKey` in place. Critical
 * for two cases:
 *
 *   1. Files uploaded before the extraction pipeline was wired up — the
 *      `thumbnailKey` column is permanently NULL on those rows because
 *      nothing reprocesses them automatically.
 *
 *   2. Files where extraction was attempted at upload time but produced
 *      nothing (silently swallowed error, missing path, EMF-only preview,
 *      etc.). After fixing the extractor, regenerating gets them
 *      thumbnails without re-uploading.
 *
 * Auth: requires FILE_EDIT permission and tenant ownership of the file.
 * Returns 200 with the new thumbnailKey on success, 200 with
 * `regenerated: false` and a `reason` when the extractor produced no
 * thumbnail (the route still updates updatedAt so the UI gets a fresh
 * timestamp). 404 / 403 / 401 for the obvious failure modes.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { fileId } = await params;
    const db = getServiceClient();

    const { data: file } = await db.from("files").select("*").eq("id", fileId).single();
    if (!file || file.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const access = await requireFileAccess(tenantUser, file, "edit");
    if (!access.ok) return access.response;

    // Released artifact is locked — including its thumbnail. The visual
    // representation is part of what was approved.
    if (file.isFrozen) {
      return NextResponse.json({ error: "Cannot regenerate the thumbnail of a frozen/released file. Revise it first." }, { status: 409 });
    }

    // We need the bytes of the *current* version. The thumbnail always
    // reflects what's released today, not historical revisions.
    const { data: version } = await db
      .from("file_versions")
      .select("storageKey")
      .eq("fileId", fileId)
      .eq("version", file.currentVersion)
      .single();

    if (!version?.storageKey) {
      return NextResponse.json(
        { error: "No version found for this file" },
        { status: 404 }
      );
    }

    // Download the file from storage. We use the service client to
    // bypass storage RLS — auth was already checked above against the
    // tenant_users + role permissions.
    const { data: blob, error: dlError } = await db.storage
      .from("vault")
      .download(version.storageKey);

    if (dlError || !blob) {
      console.error("Thumbnail regenerate: download failed:", dlError);
      return NextResponse.json(
        { error: "Failed to download file from storage" },
        { status: 500 }
      );
    }

    const arrayBuffer = await blob.arrayBuffer();
    const thumb = await extractThumbnail(arrayBuffer, file.name);

    if (!thumb) {
      // Extraction returned null. Don't touch thumbnailKey — leaving the
      // existing value intact means a previous good thumbnail (if any)
      // stays in place.
      return NextResponse.json({
        regenerated: false,
        reason:
          "The extractor couldn't find an embedded raster preview in this file. " +
          "Run `npm run debug-thumbnail` against the file locally to see what's inside.",
      });
    }

    // Upload the new thumbnail under a fresh key (timestamp-suffixed) so
    // signed-URL caches don't serve the old image. We don't bother
    // deleting the old thumbnail object — Supabase storage costs are
    // pennies and an orphaned thumbnail is harmless.
    const thumbnailKey = `${tenantUser.tenantId}/thumbnails/${Date.now()}-${file.name}.${thumb.ext}`;
    const { error: upError } = await db.storage
      .from("vault")
      .upload(thumbnailKey, thumb.data, {
        contentType: thumb.mimeType,
        upsert: false,
      });

    if (upError) {
      console.error("Thumbnail regenerate: upload failed:", upError);
      return NextResponse.json(
        { error: "Failed to upload new thumbnail" },
        { status: 500 }
      );
    }

    const now = new Date().toISOString();
    await db
      .from("files")
      .update({ thumbnailKey, thumbnailAttemptedAt: now, updatedAt: now })
      .eq("id", fileId);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "file.thumbnail.regenerated",
      entityType: "file",
      entityId: fileId,
      details: { name: file.name, size: thumb.data.length },
    });

    return NextResponse.json({
      regenerated: true,
      thumbnailKey,
      size: thumb.data.length,
    });
  } catch (err) {
    console.error("Failed to regenerate thumbnail:", err);
    const message = err instanceof Error ? err.message : "Failed to regenerate thumbnail";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
