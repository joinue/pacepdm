import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// Dedicated thumbnail mutation endpoint for parts. Lives next to the
// generic part PUT route because the storage write needs multipart
// handling and a separate code path from the JSON-only metadata update.
//
// Pattern mirrors the files module: store the storage object key on the
// row, generate a short-lived signed URL on read. The bucket is "vault",
// shared with the files module, under `{tenantId}/thumbnails/parts/`.

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — thumbnails should be small
const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

function extFromMime(mime: string): string {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  return "bin";
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ partId: string }> },
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { partId } = await params;
    const db = getServiceClient();

    const { data: part } = await db
      .from("parts")
      .select("id, partNumber, thumbnailKey")
      .eq("id", partId)
      .eq("tenantId", tenantUser.tenantId)
      .single();
    if (!part) return NextResponse.json({ error: "Part not found" }, { status: 404 });

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing file" }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: "Thumbnail too large (max 5 MB)" }, { status: 413 });
    }
    if (!ALLOWED_MIME.has(file.type)) {
      return NextResponse.json({ error: "Unsupported image type" }, { status: 415 });
    }

    const key = `${tenantUser.tenantId}/thumbnails/parts/${partId}-${Date.now()}.${extFromMime(file.type)}`;
    const { error: upErr } = await db.storage
      .from("vault")
      .upload(key, file, { contentType: file.type, upsert: false });
    if (upErr) {
      return NextResponse.json({ error: upErr.message }, { status: 500 });
    }

    // Best-effort: remove the previously linked object so abandoned
    // thumbnails don't accumulate. A failure here is not fatal — the
    // row already points at the new key.
    const oldKey = (part as { thumbnailKey: string | null }).thumbnailKey;
    if (oldKey) {
      await db.storage.from("vault").remove([oldKey]).catch(() => undefined);
    }

    const { error: updErr } = await db
      .from("parts")
      .update({ thumbnailKey: key, updatedAt: new Date().toISOString() })
      .eq("id", partId);
    if (updErr) {
      return NextResponse.json({ error: updErr.message }, { status: 500 });
    }

    const { data: signed } = await db.storage.from("vault").createSignedUrl(key, 300);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "part.thumbnail.update",
      entityType: "part",
      entityId: partId,
      details: { partNumber: part.partNumber },
    });

    return NextResponse.json({ thumbnailUrl: signed?.signedUrl || null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to upload thumbnail";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ partId: string }> },
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { partId } = await params;
    const db = getServiceClient();

    const { data: part } = await db
      .from("parts")
      .select("id, partNumber, thumbnailKey")
      .eq("id", partId)
      .eq("tenantId", tenantUser.tenantId)
      .single();
    if (!part) return NextResponse.json({ error: "Part not found" }, { status: 404 });

    const oldKey = (part as { thumbnailKey: string | null }).thumbnailKey;
    if (oldKey) {
      await db.storage.from("vault").remove([oldKey]).catch(() => undefined);
    }

    await db
      .from("parts")
      .update({ thumbnailKey: null, updatedAt: new Date().toISOString() })
      .eq("id", partId);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "part.thumbnail.delete",
      entityType: "part",
      entityId: partId,
      details: { partNumber: part.partNumber },
    });

    return NextResponse.json({ thumbnailUrl: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete thumbnail";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
