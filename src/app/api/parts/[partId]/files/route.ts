import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { v4 as uuid } from "uuid";
import { logAudit } from "@/lib/audit";

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

    const { partId } = await params;
    const body = await request.json();
    const db = getServiceClient();

    if (!body.fileId) {
      return NextResponse.json({ error: "fileId is required" }, { status: 400 });
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
    await logAudit({ tenantId: tenantUser.tenantId, userId: tenantUser.id, action: "part.file_link", entityType: "part", entityId: partId, details: { fileId: body.fileId, role: body.role || "DRAWING" } });

    return NextResponse.json(pf);
  } catch {
    return NextResponse.json({ error: "Failed to link file" }, { status: 500 });
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

    const { partId } = await params;
    const { fileId } = await request.json();
    const db = getServiceClient();

    await db.from("part_files").delete().eq("partId", partId).eq("fileId", fileId);

    await logAudit({ tenantId: tenantUser.tenantId, userId: tenantUser.id, action: "part.file_unlink", entityType: "part", entityId: partId, details: { fileId } });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to unlink file" }, { status: 500 });
  }
}
