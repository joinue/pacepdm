import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getCurrentTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { v4 as uuid } from "uuid";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const tenantUser = await getCurrentTenantUser();
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
      const supabase = await createServerSupabaseClient();
      const arrayBuffer = await newFile.arrayBuffer();
      const { error: uploadError } = await supabase.storage
        .from("vault")
        .upload(storageKey, arrayBuffer, { contentType: newFile.type, upsert: false });

      if (uploadError) {
        return NextResponse.json({ error: "Failed to upload file" }, { status: 500 });
      }

      await db.from("file_versions").insert({
        id: uuid(),
        fileId,
        version: newVersion,
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

    return NextResponse.json({ success: true, version: newFile ? newVersion : file.currentVersion });
  } catch {
    return NextResponse.json({ error: "Failed to check in file" }, { status: 500 });
  }
}
