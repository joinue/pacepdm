import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getCurrentTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { v4 as uuid } from "uuid";

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getCurrentTenantUser();
    const permissions = tenantUser.role.permissions as string[];

    if (!hasPermission(permissions, PERMISSIONS.ADMIN_METADATA)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { name, fieldType, options, isRequired } = await request.json();

    if (!name?.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

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
        name: name.trim(),
        fieldType: fieldType || "TEXT",
        options: options || null,
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

    return NextResponse.json(field);
  } catch {
    return NextResponse.json({ error: "Failed to create field" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const tenantUser = await getCurrentTenantUser();
    const permissions = tenantUser.role.permissions as string[];

    if (!hasPermission(permissions, PERMISSIONS.ADMIN_METADATA)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { fieldId } = await request.json();
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

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete field" }, { status: 500 });
  }
}
