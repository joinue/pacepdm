import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { v4 as uuid } from "uuid";
import { logAudit } from "@/lib/audit";
import { z, parseBody, nonEmptyString } from "@/lib/validation";

const CreateFieldSchema = z.object({
  name: nonEmptyString,
  fieldType: z.enum(["TEXT", "NUMBER", "DATE", "BOOLEAN", "SELECT", "URL"]).optional(),
  options: z.array(z.string()).nullable().optional(),
  isRequired: z.boolean().optional(),
});

const DeleteFieldSchema = z.object({ fieldId: nonEmptyString });

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];

    if (!hasPermission(permissions, PERMISSIONS.ADMIN_METADATA)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, CreateFieldSchema);
    if (!parsed.ok) return parsed.response;
    const { name, fieldType, options, isRequired } = parsed.data;

    const db = getServiceClient();
    const now = new Date().toISOString();

    // Get next sort order
    const { data: existing } = await db
      .from("metadata_fields")
      .select("sortOrder")
      .eq("tenantId", tenantUser.tenantId)
      .order("sortOrder", { ascending: false })
      .limit(1);

    const nextSort = existing && existing.length > 0 ? existing[0].sortOrder + 1 : 0;

    const { data: field, error } = await db
      .from("metadata_fields")
      .insert({
        id: uuid(),
        tenantId: tenantUser.tenantId,
        name,
        fieldType: fieldType || "TEXT",
        options: options ?? null,
        isRequired: isRequired || false,
        isSystem: false,
        sortOrder: nextSort,
        appliesTo: [],
        createdAt: now,
        updatedAt: now,
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: "A field with this name already exists" }, { status: 409 });
      }
      throw error;
    }

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "metadata_field.create", entityType: "metadata_field",
      entityId: field.id, details: { name, fieldType: fieldType || "TEXT" },
    });

    return NextResponse.json(field);
  } catch (err) {
    console.error("Failed to create field:", err);
    const message = err instanceof Error ? err.message : "Failed to create field";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];

    if (!hasPermission(permissions, PERMISSIONS.ADMIN_METADATA)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, DeleteFieldSchema);
    if (!parsed.ok) return parsed.response;
    const { fieldId } = parsed.data;

    const db = getServiceClient();

    const { data: field } = await db.from("metadata_fields").select("*").eq("id", fieldId).single();
    if (!field || field.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "Field not found" }, { status: 404 });
    }
    if (field.isSystem) {
      return NextResponse.json({ error: "Cannot delete system fields" }, { status: 400 });
    }

    await db.from("metadata_values").delete().eq("fieldId", fieldId);
    await db.from("metadata_fields").delete().eq("id", fieldId);

    await logAudit({ tenantId: tenantUser.tenantId, userId: tenantUser.id, action: "metadata_field.delete", entityType: "metadata_field", entityId: fieldId, details: { name: field.name } });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Failed to delete field:", err);
    const message = err instanceof Error ? err.message : "Failed to delete field";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
