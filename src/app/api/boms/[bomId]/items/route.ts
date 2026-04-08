import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { v4 as uuid } from "uuid";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ bomId: string }> }
) {
  try {
    await getApiTenantUser();
    const { bomId } = await params;
    const db = getServiceClient();

    const { data: items } = await db
      .from("bom_items")
      .select("*, file:files!bom_items_fileId_fkey(id, name, partNumber, revision, lifecycleState), part:parts!bom_items_partId_fkey(id, partNumber, name, category, thumbnailUrl, unitCost), linkedBom:boms!bom_items_linkedBomId_fkey(id, name, revision, status)")
      .eq("bomId", bomId)
      .order("sortOrder");

    return NextResponse.json(items || []);
  } catch {
    return NextResponse.json({ error: "Failed to fetch BOM items" }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ bomId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { bomId } = await params;
    const body = await request.json();
    const db = getServiceClient();
    const now = new Date().toISOString();

    const { data: item, error } = await db.from("bom_items").insert({
      id: uuid(),
      bomId,
      fileId: body.fileId || null,
      partId: body.partId || null,
      linkedBomId: body.linkedBomId || null,
      itemNumber: body.itemNumber || "",
      partNumber: body.partNumber || null,
      name: body.name || "",
      description: body.description || null,
      quantity: body.quantity || 1,
      unit: body.unit || "EA",
      level: body.level || 1,
      parentItemId: body.parentItemId || null,
      material: body.material || null,
      vendor: body.vendor || null,
      unitCost: body.unitCost || null,
      sortOrder: body.sortOrder || 0,
      createdAt: now,
      updatedAt: now,
    }).select().single();

    if (error) throw error;

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "bom.item.add", entityType: "bom", entityId: bomId,
      details: { itemName: body.name || "", itemNumber: body.itemNumber || "" },
    });

    return NextResponse.json(item);
  } catch {
    return NextResponse.json({ error: "Failed to add BOM item" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ bomId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { bomId } = await params;
    const { itemId } = await request.json();
    const db = getServiceClient();

    // Get item name for audit before deleting
    const { data: existing } = await db.from("bom_items").select("name, itemNumber").eq("id", itemId).single();

    await db.from("bom_items").delete().eq("id", itemId).eq("bomId", bomId);

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "bom.item.delete", entityType: "bom", entityId: bomId,
      details: { itemName: existing?.name || "", itemNumber: existing?.itemNumber || "" },
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete BOM item" }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ bomId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { bomId } = await params;
    const body = await request.json();
    const db = getServiceClient();

    if (!body.itemId) {
      return NextResponse.json({ error: "itemId is required" }, { status: 400 });
    }

    const updates: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };

    const fields = ["fileId", "partId", "linkedBomId", "itemNumber", "partNumber", "name", "description", "quantity", "unit", "level", "parentItemId", "material", "vendor", "unitCost", "sortOrder"] as const;
    for (const field of fields) {
      if (body[field] !== undefined) {
        updates[field] = body[field];
      }
    }

    const { data: item, error } = await db
      .from("bom_items")
      .update(updates)
      .eq("id", body.itemId)
      .eq("bomId", bomId)
      .select()
      .single();

    if (error) throw error;

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "bom.item.update", entityType: "bom", entityId: bomId,
      details: { itemName: item.name, itemNumber: item.itemNumber },
    });

    return NextResponse.json(item);
  } catch {
    return NextResponse.json({ error: "Failed to update BOM item" }, { status: 500 });
  }
}
