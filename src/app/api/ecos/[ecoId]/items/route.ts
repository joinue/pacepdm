import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { v4 as uuid } from "uuid";
import { z, parseBody, nonEmptyString, optionalString } from "@/lib/validation";

// An ECO item targets either a part (preferred — the part is the PDM's
// central object, and changing a part cascades to its linked files on
// implement) or a single file (for loose documents not attached to any
// part). Exactly one of partId/fileId must be supplied — the DB CHECK
// in migration 017 enforces this too, we just surface a clearer error
// at the API boundary.
const AddEcoItemSchema = z
  .object({
    partId: z.string().trim().min(1).optional(),
    fileId: z.string().trim().min(1).optional(),
    changeType: z.enum(["ADD", "MODIFY", "REMOVE"]),
    reason: optionalString,
    // Only meaningful for part items. Server auto-bumps (A→B) when
    // omitted, so these fields are both optional.
    fromRevision: optionalString,
    toRevision: optionalString,
  })
  .refine((v) => (v.partId ? 1 : 0) + (v.fileId ? 1 : 0) === 1, {
    message: "Provide exactly one of partId or fileId",
    path: ["partId"],
  });

const RemoveEcoItemSchema = z.object({
  itemId: nonEmptyString,
});

const ITEM_SELECT =
  "*, " +
  "file:files!eco_items_fileId_fkey(id, name, partNumber, lifecycleState, currentVersion), " +
  "part:parts!eco_items_partId_fkey(id, partNumber, name, revision, lifecycleState, category)";

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
      .select(ITEM_SELECT)
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
    const { partId, fileId, changeType, reason, fromRevision, toRevision } = parsed.data;

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

    // Cross-tenant guard: the target part/file must belong to the caller's
    // tenant. The DB RLS story is still service-role-based, so we enforce
    // here. Also capture the part's current revision to seed fromRevision
    // when the caller didn't supply it — makes the history self-explaining.
    let seededFromRevision: string | null = fromRevision ?? null;
    if (partId) {
      const { data: part } = await db
        .from("parts")
        .select("id, tenantId, revision")
        .eq("id", partId)
        .single();
      if (!part || part.tenantId !== tenantUser.tenantId) {
        return NextResponse.json({ error: "Part not found" }, { status: 404 });
      }
      if (!seededFromRevision) seededFromRevision = part.revision;

      const { data: existing } = await db.from("eco_items")
        .select("id")
        .eq("ecoId", ecoId)
        .eq("partId", partId)
        .maybeSingle();
      if (existing) {
        return NextResponse.json({ error: "This part is already in this ECO" }, { status: 409 });
      }
    } else if (fileId) {
      const { data: file } = await db
        .from("files")
        .select("id, tenantId")
        .eq("id", fileId)
        .single();
      if (!file || file.tenantId !== tenantUser.tenantId) {
        return NextResponse.json({ error: "File not found" }, { status: 404 });
      }

      const { data: existing } = await db.from("eco_items")
        .select("id")
        .eq("ecoId", ecoId)
        .eq("fileId", fileId)
        .maybeSingle();
      if (existing) {
        return NextResponse.json({ error: "This file is already in this ECO" }, { status: 409 });
      }
    }

    const { data: item, error } = await db.from("eco_items").insert({
      id: uuid(),
      ecoId,
      partId: partId ?? null,
      fileId: fileId ?? null,
      changeType,
      reason: reason ?? null,
      fromRevision: seededFromRevision,
      toRevision: toRevision ?? null,
    }).select(ITEM_SELECT).single();

    if (error) throw error;

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "eco.item.added",
      entityType: "eco",
      entityId: ecoId,
      details: {
        ecoNumber: eco.ecoNumber,
        target: partId ? "part" : "file",
        partId: partId ?? null,
        fileId: fileId ?? null,
        changeType,
      },
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
