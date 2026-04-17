import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { v4 as uuid } from "uuid";
import { z, parseBody, optionalString } from "@/lib/validation";
import { requireFileAccess } from "@/lib/folder-access-guards";

const MetadataSchema = z.object({
  partNumber: optionalString,
  description: optionalString,
  category: z.string().optional(),
  metadata: z.array(z.object({
    fieldId: z.string(),
    value: z.union([z.string(), z.number(), z.boolean()]),
  })).optional(),
});

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

    const parsed = await parseBody(request, MetadataSchema);
    if (!parsed.ok) return parsed.response;
    const { metadata, partNumber, description, category } = parsed.data;

    const db = getServiceClient();

    const { data: file } = await db.from("files").select("*").eq("id", fileId).single();
    if (!file || file.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const access = await requireFileAccess(tenantUser, file, "edit");
    if (!access.ok) return access.response;

    // Frozen files can only be edited by admins
    if (file.isFrozen && !permissions.includes("*")) {
      return NextResponse.json({ error: "Cannot edit a frozen/released file. Revise it first." }, { status: 409 });
    }

    // Checked-out files can only be edited by the checkout owner (or admins)
    if (file.isCheckedOut && file.checkedOutById !== tenantUser.id && !permissions.includes("*")) {
      return NextResponse.json({ error: "File is checked out by another user" }, { status: 423 });
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
  } catch (err) {
    console.error("Failed to update metadata:", err);
    const message = err instanceof Error ? err.message : "Failed to update metadata";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
