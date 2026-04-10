import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { v4 as uuid } from "uuid";
import { z, parseBody, nonEmptyString, optionalString } from "@/lib/validation";

const AddEcoItemSchema = z.object({
  fileId: nonEmptyString,
  changeType: z.enum(["ADD", "MODIFY", "REMOVE"]),
  reason: optionalString,
});

const RemoveEcoItemSchema = z.object({
  itemId: nonEmptyString,
});

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
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch ECO items";
    return NextResponse.json({ error: message }, { status: 500 });
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

    const parsed = await parseBody(request, AddEcoItemSchema);
    if (!parsed.ok) return parsed.response;
    const { fileId, changeType, reason } = parsed.data;

    const { ecoId } = await params;
    const db = getServiceClient();

    // Verify ECO is in DRAFT and belongs to tenant
    const { data: eco } = await db.from("ecos")
      .select("id, status, ecoNumber")
      .eq("id", ecoId)
      .eq("tenantId", tenantUser.tenantId)
      .single();
    if (!eco) return NextResponse.json({ error: "ECO not found" }, { status: 404 });
    if (eco.status !== "DRAFT") {
      return NextResponse.json({ error: "Can only add items to DRAFT ECOs" }, { status: 400 });
    }

    // Reject duplicate file links — same file can only be in one ECO row
    const { data: existing } = await db.from("eco_items")
      .select("id")
      .eq("ecoId", ecoId)
      .eq("fileId", fileId)
      .single();
    if (existing) {
      return NextResponse.json({ error: "This file is already in this ECO" }, { status: 409 });
    }

    const { data: item, error } = await db.from("eco_items").insert({
      id: uuid(),
      ecoId,
      fileId,
      changeType,
      reason: reason ?? null,
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
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to add ECO item";
    return NextResponse.json({ error: message }, { status: 500 });
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

    const parsed = await parseBody(request, RemoveEcoItemSchema);
    if (!parsed.ok) return parsed.response;
    const { itemId } = parsed.data;

    const { ecoId } = await params;
    const db = getServiceClient();

    const { data: eco } = await db.from("ecos")
      .select("id, status, ecoNumber")
      .eq("id", ecoId)
      .eq("tenantId", tenantUser.tenantId)
      .single();
    if (!eco) return NextResponse.json({ error: "ECO not found" }, { status: 404 });
    if (eco.status !== "DRAFT") {
      return NextResponse.json({ error: "Can only remove items from DRAFT ECOs" }, { status: 400 });
    }

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
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to remove ECO item";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
