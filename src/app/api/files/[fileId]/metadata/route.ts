import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { v4 as uuid } from "uuid";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

    const { metadata, partNumber, description, category } = await request.json();

    // Frozen files can only be edited by admins
    if (file.isFrozen && !permissions.includes("*")) {
      return NextResponse.json({ error: "Cannot edit a frozen/released file. Revise it first." }, { status: 409 });
    }

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (partNumber !== undefined) updates.partNumber = partNumber;
    if (description !== undefined) updates.description = description;
    if (category) updates.category = category;

    await db.from("files").update(updates).eq("id", fileId);

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
