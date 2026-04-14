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

// We deliberately do NOT use PostgREST embed hints like
// `part:parts!eco_items_partId_fkey(...)` here. Those were silently
// coming back null — the joined rows never materialized — which
// manifested as "Affected Items is empty even though eco_items has
// rows in the DB". Rather than chase the schema-cache / constraint
// name the resolver was unhappy about, just fetch the raw item rows
// and hydrate the part/file sides with two cheap batched selects.
//
// Note: `eco_items` has no `createdAt` column (see migration-001 /
// migration-017 — the schema was never backfilled with one). Ordering
// by `id` is good enough for a stable, deterministic display order;
// the previous `.order("createdAt")` was silently erroring and is what
// actually caused the empty-list bug.

type RawItem = {
  id: string;
  ecoId: string;
  partId: string | null;
  fileId: string | null;
  changeType: string;
  reason: string | null;
  fromRevision: string | null;
  toRevision: string | null;
};

type HydratedItem = RawItem & {
  part: {
    id: string;
    partNumber: string;
    name: string;
    revision: string;
    lifecycleState: string;
    category: string;
  } | null;
  file: {
    id: string;
    name: string;
    partNumber: string | null;
    lifecycleState: string;
    currentVersion: number;
  } | null;
};

async function hydrateItems(
  db: ReturnType<typeof getServiceClient>,
  rows: RawItem[]
): Promise<HydratedItem[]> {
  const partIds = Array.from(new Set(rows.map((r) => r.partId).filter((v): v is string => !!v)));
  const fileIds = Array.from(new Set(rows.map((r) => r.fileId).filter((v): v is string => !!v)));

  const [partsRes, filesRes] = await Promise.all([
    partIds.length
      ? db.from("parts").select("id, partNumber, name, revision, lifecycleState, category").in("id", partIds)
      : Promise.resolve({ data: [] as HydratedItem["part"][], error: null }),
    fileIds.length
      ? db.from("files").select("id, name, partNumber, lifecycleState, currentVersion").in("id", fileIds)
      : Promise.resolve({ data: [] as HydratedItem["file"][], error: null }),
  ]);

  if (partsRes.error) throw partsRes.error;
  if (filesRes.error) throw filesRes.error;

  const partById = new Map((partsRes.data ?? []).map((p) => [p!.id, p!] as const));
  const fileById = new Map((filesRes.data ?? []).map((f) => [f!.id, f!] as const));

  return rows.map((r) => ({
    ...r,
    part: r.partId ? partById.get(r.partId) ?? null : null,
    file: r.fileId ? fileById.get(r.fileId) ?? null : null,
  }));
}

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
    const { data: eco } = await db.from("ecos").select("id").eq("id", ecoId).eq("tenantId", tenantUser.tenantId).maybeSingle();
    if (!eco) return NextResponse.json({ error: "ECO not found" }, { status: 404 });

    const { data: rawItems, error } = await db
      .from("eco_items")
      .select("id, ecoId, partId, fileId, changeType, reason, fromRevision, toRevision")
      .eq("ecoId", ecoId)
      .order("id", { ascending: true });

    if (error) {
      console.error(`[ecos/${ecoId}/items] GET failed:`, error);
      return NextResponse.json(
        { error: `Query failed: ${error.message}` },
        { status: 500 }
      );
    }

    const hydrated = await hydrateItems(db, (rawItems ?? []) as RawItem[]);
    return NextResponse.json(hydrated);
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

    const { data: rawItem, error } = await db.from("eco_items").insert({
      id: uuid(),
      ecoId,
      partId: partId ?? null,
      fileId: fileId ?? null,
      changeType,
      reason: reason ?? null,
      fromRevision: seededFromRevision,
      toRevision: toRevision ?? null,
    }).select("id, ecoId, partId, fileId, changeType, reason, fromRevision, toRevision").single();

    if (error) throw error;

    const [item] = await hydrateItems(db, [rawItem as RawItem]);

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
