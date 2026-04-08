import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { v4 as uuid } from "uuid";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ ecoId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { ecoId } = await params;
    const db = getServiceClient();

    // Verify ECO belongs to tenant
    const { data: eco } = await db.from("ecos").select("id").eq("id", ecoId).eq("tenantId", tenantUser.tenantId).single();
    if (!eco) return NextResponse.json({ error: "ECO not found" }, { status: 404 });

    const { data: items } = await db
      .from("eco_items")
      .select("*, file:files!eco_items_fileId_fkey(id, name, partNumber, lifecycleState, currentVersion)")
      .eq("ecoId", ecoId)
      .order("createdAt", { ascending: true });

    return NextResponse.json(items || []);
  } catch {
    return NextResponse.json({ error: "Failed to fetch ECO items" }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ ecoId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.ECO_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { ecoId } = await params;
    const { fileId, changeType, reason } = await request.json();
    const db = getServiceClient();

    // Verify ECO is in DRAFT and belongs to tenant
    const { data: eco } = await db.from("ecos").select("id, status, ecoNumber").eq("id", ecoId).eq("tenantId", tenantUser.tenantId).single();
    if (!eco) return NextResponse.json({ error: "ECO not found" }, { status: 404 });
    if (eco.status !== "DRAFT") return NextResponse.json({ error: "Can only add items to DRAFT ECOs" }, { status: 400 });

    if (!fileId || !changeType) {
      return NextResponse.json({ error: "fileId and changeType are required" }, { status: 400 });
    }

    // Check for duplicate
    const { data: existing } = await db.from("eco_items").select("id").eq("ecoId", ecoId).eq("fileId", fileId).single();
    if (existing) return NextResponse.json({ error: "This file is already in this ECO" }, { status: 409 });

    const { data: item, error } = await db.from("eco_items").insert({
      id: uuid(),
      ecoId,
      fileId,
      changeType,
      reason: reason?.trim() || null,
    }).select("*, file:files!eco_items_fileId_fkey(id, name, partNumber, lifecycleState, currentVersion)").single();

    if (error) throw error;

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "eco.item.added",
      entityType: "eco",
      entityId: ecoId,
      details: { ecoNumber: eco.ecoNumber, fileId, changeType },
    });

    return NextResponse.json(item);
  } catch {
    return NextResponse.json({ error: "Failed to add ECO item" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ ecoId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.ECO_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { ecoId } = await params;
    const { itemId } = await request.json();
    const db = getServiceClient();

    const { data: eco } = await db.from("ecos").select("id, status, ecoNumber").eq("id", ecoId).eq("tenantId", tenantUser.tenantId).single();
    if (!eco) return NextResponse.json({ error: "ECO not found" }, { status: 404 });
    if (eco.status !== "DRAFT") return NextResponse.json({ error: "Can only remove items from DRAFT ECOs" }, { status: 400 });

    await db.from("eco_items").delete().eq("id", itemId).eq("ecoId", ecoId);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "eco.item.removed",
      entityType: "eco",
      entityId: ecoId,
      details: { ecoNumber: eco.ecoNumber, itemId },
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to remove ECO item" }, { status: 500 });
  }
}
