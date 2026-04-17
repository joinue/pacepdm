import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { extractThumbnail } from "@/lib/thumbnail";
import { requireFileAccess } from "@/lib/folder-access-guards";

/**
 * POST /api/files/[fileId]/thumbnail/set
 *
 * Manual thumbnail upload. This is the escape hatch for files whose
 * automatic extraction failed or was impossible in the first place —
 * e.g., SolidWorks files saved without the "Save preview picture"
 * option, STEP files, DWG files, anything where pure-JS extraction
 * can't produce a raster from what's in the file.
 *
 * Accepts a multipart form with a single "image" field. Runs it through
 * the same image-thumbnail resizer the upload path uses (sharp, 400px
 * bounded, PNG output) so the result is normalised regardless of what
 * the user uploaded. Stores it at the usual tenant-scoped storage path
 * and updates `files.thumbnailKey`.
 *
 * Auth: FILE_EDIT permission + tenant ownership. Same bar as regenerate.
 */
export async function POST(
  request: NextRequest,
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
      return NextResponse.json({ error: "Cannot change the thumbnail of a frozen/released file. Revise it first." }, { status: 409 });
    }

    const formData = await request.formData();
    const image = formData.get("image") as globalThis.File | null;
    if (!image) {
      return NextResponse.json({ error: "Missing 'image' field" }, { status: 400 });
    }

    // Sanity-check content type and size. The extractor itself rejects
    // garbage (sharp throws on non-images), but failing fast here is
    // cheaper and gives a clearer error.
    const contentType = image.type || "";
    if (!/^image\//.test(contentType)) {
      return NextResponse.json(
        { error: `Unsupported image content-type: ${contentType || "(unknown)"}` },
        { status: 400 }
      );
    }
    const MAX_BYTES = 10 * 1024 * 1024;
    if (image.size > MAX_BYTES) {
      return NextResponse.json(
        { error: "Image too large — 10 MB max" },
        { status: 400 }
      );
    }

    // Normalise via the dispatcher. The image branch in extractThumbnail
    // already does a sharp resize to a 400px-bounded PNG, which is
    // exactly what we want — same path as auto-extracted thumbnails, so
    // manual uploads look consistent with extracted ones.
    const arrayBuffer = await image.arrayBuffer();
    const thumb = await extractThumbnail(arrayBuffer, image.name || "upload.png");
    if (!thumb) {
      return NextResponse.json(
        { error: "Could not process the uploaded image (not a supported raster format?)" },
        { status: 400 }
      );
    }

    // Upload under a fresh timestamped key so signed-URL caches don't
    // serve the old thumbnail. We don't bother deleting any previous
    // thumbnail object — orphaned thumbnails are cheap and harmless.
    const thumbnailKey = `${tenantUser.tenantId}/thumbnails/${Date.now()}-${file.name}.${thumb.ext}`;
    const { error: upError } = await db.storage
      .from("vault")
      .upload(thumbnailKey, thumb.data, {
        contentType: thumb.mimeType,
        upsert: false,
      });
    if (upError) {
      console.error("Manual thumbnail upload: storage upload failed:", upError);
      return NextResponse.json(
        { error: "Failed to upload thumbnail to storage" },
        { status: 500 }
      );
    }

    const now = new Date().toISOString();
    await db
      .from("files")
      .update({ thumbnailKey, updatedAt: now })
      .eq("id", fileId);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "file.thumbnail.manual_upload",
      entityType: "file",
      entityId: fileId,
      details: { name: file.name, size: thumb.data.length, source: image.name || "upload" },
    });

    return NextResponse.json({
      success: true,
      thumbnailKey,
      size: thumb.data.length,
    });
  } catch (err) {
    console.error("Failed to set thumbnail:", err);
    const message = err instanceof Error ? err.message : "Failed to set thumbnail";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
