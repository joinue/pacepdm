import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { v4 as uuid } from "uuid";
import { logAudit } from "@/lib/audit";
import { z, parseBody, nonEmptyString } from "@/lib/validation";

const LinkFileSchema = z.object({
  fileId: nonEmptyString,
  role: z.string().optional(),
  isPrimary: z.boolean().optional(),
});

const UnlinkFileSchema = z.object({ fileId: nonEmptyString });

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ partId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, LinkFileSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const { partId } = await params;
    const db = getServiceClient();

    // Snapshot the file name for the audit log — tenant-scoped lookup also
    // prevents linking a file from another tenant by guessing IDs.
    const { data: fileRecord } = await db
      .from("files")
      .select("id, name, isCheckedOut, checkedOutById")
      .eq("id", body.fileId)
      .eq("tenantId", tenantUser.tenantId)
      .single();
    if (!fileRecord) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    // Checked-out files can only have links changed by the checkout owner (or admins)
    if (fileRecord.isCheckedOut && fileRecord.checkedOutById !== tenantUser.id && !permissions.includes("*")) {
      return NextResponse.json({ error: "File is checked out by another user" }, { status: 423 });
    }

    // If setting as primary, unset others
    if (body.isPrimary) {
      await db.from("part_files").update({ isPrimary: false }).eq("partId", partId);
    }

    const { data: pf, error } = await db.from("part_files").insert({
      id: uuid(),
      partId,
      fileId: body.fileId,
      role: body.role || "DRAWING",
      isPrimary: body.isPrimary || false,
      createdAt: new Date().toISOString(),
    }).select().single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: "This file is already linked to this part" }, { status: 409 });
      }
      throw error;
    }
    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "part.file_link",
      entityType: "part",
      entityId: partId,
      details: { fileId: body.fileId, fileName: fileRecord.name, role: body.role || "DRAWING" },
    });

    return NextResponse.json(pf);
  } catch (err) {
    console.error("Failed to link file:", err);
    const message = err instanceof Error ? err.message : "Failed to link file";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ partId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, UnlinkFileSchema);
    if (!parsed.ok) return parsed.response;
    const { fileId } = parsed.data;

    const { partId } = await params;
    const db = getServiceClient();

    // Snapshot the file name before the link is gone, so the audit entry
    // remains readable even if the file is later renamed or deleted.
    const { data: fileRecord } = await db
      .from("files")
      .select("name, isCheckedOut, checkedOutById")
      .eq("id", fileId)
      .eq("tenantId", tenantUser.tenantId)
      .single();

    // Checked-out files can only have links changed by the checkout owner (or admins)
    if (fileRecord?.isCheckedOut && fileRecord.checkedOutById !== tenantUser.id && !permissions.includes("*")) {
      return NextResponse.json({ error: "File is checked out by another user" }, { status: 423 });
    }

    await db.from("part_files").delete().eq("partId", partId).eq("fileId", fileId);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "part.file_unlink",
      entityType: "part",
      entityId: partId,
      details: { fileId, fileName: fileRecord?.name ?? null },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Failed to unlink file:", err);
    const message = err instanceof Error ? err.message : "Failed to unlink file";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
