import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getCurrentTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { v4 as uuid } from "uuid";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const tenantUser = await getCurrentTenantUser();
    const permissions = tenantUser.role.permissions as string[];
    const { fileId } = await params;

    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const db = getServiceClient();

    const { data: file } = await db.from("files").select("*").eq("id", fileId).single();
    if (!file || file.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const { metadata, partNumber, description } = await request.json();

    await db.from("files").update({
      partNumber: partNumber ?? file.partNumber,
      description: description ?? file.description,
      updatedAt: new Date().toISOString(),
    }).eq("id", fileId);

    if (metadata && Array.isArray(metadata)) {
      for (const { fieldId, value } of metadata) {
        const { data: existing } = await db
          .from("metadata_values")
          .select("id")
          .eq("fileId", fileId)
          .eq("fieldId", fieldId)
          .single();

        if (existing) {
          await db.from("metadata_values").update({ value: String(value) }).eq("id", existing.id);
        } else {
          await db.from("metadata_values").insert({
            id: uuid(),
            fileId,
            fieldId,
            value: String(value),
          });
        }
      }
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "file.metadata_update",
      entityType: "file",
      entityId: fileId,
      details: { name: file.name },
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to update metadata" }, { status: 500 });
  }
}
