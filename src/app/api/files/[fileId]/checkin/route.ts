import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { createServerSupabaseClient } from "@/lib/supabase/server";

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

    const file = await prisma.file.findUnique({ where: { id: fileId } });

    if (!file || file.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    if (!file.isCheckedOut) {
      return NextResponse.json(
        { error: "File is not checked out" },
        { status: 409 }
      );
    }

    if (file.checkedOutById !== tenantUser.id) {
      // Allow admins to force check-in
      if (!hasPermission(permissions, "admin.settings")) {
        return NextResponse.json(
          { error: "File is checked out by another user" },
          { status: 403 }
        );
      }
    }

    const formData = await request.formData();
    const newFile = formData.get("file") as globalThis.File | null;
    const comment = formData.get("comment") as string | null;

    const newVersion = file.currentVersion + 1;

    if (newFile) {
      // Upload new version
      const storageKey = `${tenantUser.tenantId}/${file.folderId}/${Date.now()}-${newFile.name}`;
      const supabase = await createServerSupabaseClient();

      const arrayBuffer = await newFile.arrayBuffer();
      const { error: uploadError } = await supabase.storage
        .from("vault")
        .upload(storageKey, arrayBuffer, {
          contentType: newFile.type,
          upsert: false,
        });

      if (uploadError) {
        return NextResponse.json(
          { error: "Failed to upload file" },
          { status: 500 }
        );
      }

      await prisma.$transaction(async (tx) => {
        await tx.fileVersion.create({
          data: {
            fileId,
            version: newVersion,
            storageKey,
            fileSize: newFile.size,
            uploadedById: tenantUser.id,
            comment,
          },
        });

        await tx.file.update({
          where: { id: fileId },
          data: {
            currentVersion: newVersion,
            isCheckedOut: false,
            checkedOutById: null,
            checkedOutAt: null,
          },
        });
      });
    } else {
      // Check in without new version (undo checkout)
      await prisma.file.update({
        where: { id: fileId },
        data: {
          isCheckedOut: false,
          checkedOutById: null,
          checkedOutAt: null,
        },
      });
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: newFile ? "file.checkin" : "file.undo_checkout",
      entityType: "file",
      entityId: fileId,
      details: {
        name: file.name,
        version: newFile ? newVersion : file.currentVersion,
        comment,
      },
    });

    return NextResponse.json({ success: true, version: newFile ? newVersion : file.currentVersion });
  } catch {
    return NextResponse.json(
      { error: "Failed to check in file" },
      { status: 500 }
    );
  }
}
