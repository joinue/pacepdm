import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { v4 as uuid } from "uuid";
import { z, parseBody, nonEmptyString, optionalString, optionalUuid } from "@/lib/validation";
import { wouldCreateCycle, type RollupBom } from "@/lib/bom-rollup";

// ─── Mutation guard ───────────────────────────────────────────────────────
//
// A BOM item is mutable iff:
//   1. The BOM exists in the caller's tenant
//   2. The BOM itself is not RELEASED or OBSOLETE
//   3. The parent file (if any) is not frozen
//
// Rule 3 closes a gap where a BOM in WIP could be edited even though
// its parent file had been independently released — the audit trail of
// the released file would then drift from the BOM rows. BOMs without a
// parent file (`fileId IS NULL`) bypass rule 3.
async function requireBomMutable(
  db: ReturnType<typeof getServiceClient>,
  bomId: string,
  tenantId: string
): Promise<{ ok: true; bom: { id: string; status: string; fileId: string | null } } | { ok: false; status: number; error: string }> {
  const { data: bom } = await db
    .from("boms")
    .select("id, status, fileId, file:files!boms_fileId_fkey(isFrozen)")
    .eq("id", bomId)
    .eq("tenantId", tenantId)
    .single();

  if (!bom) {
    return { ok: false, status: 404, error: "BOM not found" };
  }
  if (bom.status === "RELEASED" || bom.status === "OBSOLETE") {
    return { ok: false, status: 400, error: `Cannot modify items on a ${bom.status} BOM` };
  }
  // Supabase returns the joined relation as either a single row or an
  // array depending on the join cardinality — handle both shapes.
  const parentFile = Array.isArray(bom.file) ? bom.file[0] : bom.file;
  if (parentFile?.isFrozen) {
    return {
      ok: false,
      status: 409,
      error: "Cannot modify items on a BOM whose parent file is frozen/released. Revise the file first.",
    };
  }
  return { ok: true, bom: { id: bom.id, status: bom.status, fileId: bom.fileId } };
}

// ─── Cycle check helper ───────────────────────────────────────────────────
//
// When a BOM item sets `linkedBomId`, we need to refuse the write if the
// link would close a cycle (BOM A → BOM B → BOM A). The check fetches
// every BOM reachable from the target sub-BOM in the same tenant, then
// runs the pure DFS in `wouldCreateCycle`.
//
// Tenant-scoped: we deliberately only fetch BOMs from the caller's tenant
// so a cross-tenant link is rejected as "BOM not found" before we even
// reach the cycle check.
async function checkLinkedBomSafe(
  db: ReturnType<typeof getServiceClient>,
  tenantId: string,
  parentBomId: string,
  targetBomId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Verify the target BOM exists and is in the same tenant.
  const { data: target } = await db
    .from("boms")
    .select("id")
    .eq("id", targetBomId)
    .eq("tenantId", tenantId)
    .single();
  if (!target) {
    return { ok: false, error: "Linked BOM not found" };
  }

  // Walk every BOM reachable from the target so the in-memory cycle check
  // has the full subtree to traverse. We use a small BFS that mirrors the
  // rollup endpoint — same MAX_BOMS guard against runaway trees.
  const MAX_BOMS = 500;
  const bomsById = new Map<string, RollupBom>();
  const toFetch = new Set<string>([parentBomId, targetBomId]);
  let safety = 0;

  while (toFetch.size > 0) {
    if (++safety > MAX_BOMS) {
      return { ok: false, error: "BOM tree exceeds maximum size for cycle check" };
    }
    const ids = Array.from(toFetch);
    toFetch.clear();

    const [{ data: bomRows }, { data: itemRows }] = await Promise.all([
      db
        .from("boms")
        .select("id, name, revision")
        .eq("tenantId", tenantId)
        .in("id", ids),
      db
        .from("bom_items")
        .select("id, bomId, linkedBomId, itemNumber, partNumber, name, quantity, unit, unitCost")
        .in("bomId", ids),
    ]);

    const itemsByBom = new Map<string, RollupBom["items"]>();
    for (const item of itemRows || []) {
      const list = itemsByBom.get(item.bomId) || [];
      list.push({
        id: item.id,
        bomId: item.bomId,
        linkedBomId: item.linkedBomId,
        itemNumber: item.itemNumber || "",
        partNumber: item.partNumber,
        name: item.name || "",
        quantity: item.quantity ?? 0,
        unit: item.unit || "EA",
        unitCost: item.unitCost,
      });
      itemsByBom.set(item.bomId, list);
      if (item.linkedBomId && !bomsById.has(item.linkedBomId)) {
        toFetch.add(item.linkedBomId);
      }
    }
    for (const b of bomRows || []) {
      bomsById.set(b.id, {
        id: b.id,
        name: b.name,
        revision: b.revision,
        items: itemsByBom.get(b.id) || [],
      });
    }
  }

  const cyclePath = wouldCreateCycle(parentBomId, targetBomId, bomsById);
  if (cyclePath) {
    return { ok: false, error: `Cycle detected: ${cyclePath.join(" → ")}` };
  }
  return { ok: true };
}

// ─── Validation schemas ───────────────────────────────────────────────────
//
// Shared by single-item POST, bulk-item POST, and PUT. Each field is
// optional at this layer because the database has its own defaults and we
// want to allow partial updates from PUT — but the keys we accept are
// constrained, and types like quantity/unitCost are validated as numbers
// instead of accepting arbitrary JSON.

const BomItemInputSchema = z.object({
  fileId: optionalUuid,
  partId: optionalUuid,
  linkedBomId: optionalUuid,
  itemNumber: z.string().optional(),
  partNumber: optionalString,
  name: z.string().optional(),
  description: optionalString,
  quantity: z.number().nonnegative().optional(),
  unit: z.string().optional(),
  level: z.number().int().nonnegative().optional(),
  parentItemId: optionalUuid,
  material: optionalString,
  vendor: optionalString,
  unitCost: z.number().nonnegative().nullable().optional(),
  sortOrder: z.number().int().nonnegative().optional(),
});

const PostBodySchema = z.union([
  // Single-item insert
  BomItemInputSchema,
  // Bulk insert (CSV import path)
  z.object({
    items: z.array(BomItemInputSchema).max(1000, "Cannot insert more than 1000 items in a single batch"),
  }),
]);

const PutBodySchema = BomItemInputSchema.extend({
  itemId: nonEmptyString,
});

const DeleteBodySchema = z.object({
  itemId: nonEmptyString,
});

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ bomId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { bomId } = await params;
    const db = getServiceClient();

    // Verify the BOM belongs to this tenant before returning items
    const { data: bom } = await db
      .from("boms")
      .select("id")
      .eq("id", bomId)
      .eq("tenantId", tenantUser.tenantId)
      .single();
    if (!bom) {
      return NextResponse.json({ error: "BOM not found" }, { status: 404 });
    }

    const { data: items } = await db
      .from("bom_items")
      // The `part:parts!...` join fetches *live* fields so the UI can
      // prefer them over the snapshot columns on `bom_items`. This is the
      // fix for "BOMs showing stale part data after a part is renamed or
      // rev-bumped" — the snapshot still sits on the row as a fallback
      // for free-text items and for deleted parts, but when partId is
      // set the table reads partNumber/name/description/material/unit/
      // unitCost/revision/lifecycleState from the part itself.
      .select("*, file:files!bom_items_fileId_fkey(id, name, partNumber, revision, lifecycleState), part:parts!bom_items_partId_fkey(id, partNumber, name, description, category, revision, lifecycleState, material, unit, unitCost, thumbnailKey), linkedBom:boms!bom_items_linkedBomId_fkey(id, name, revision, status)")
      .eq("bomId", bomId)
      .order("sortOrder");

    // Resolve part thumbnailKey -> signed URL (300s) so the BOM table can
    // render previews. Frontend reads `part.thumbnailUrl`, mirroring the
    // shape returned by the parts list/detail endpoints.
    const rows = items || [];
    const keys = Array.from(
      new Set(
        rows
          .map((r) => (r.part as { thumbnailKey: string | null } | null)?.thumbnailKey)
          .filter((k): k is string => !!k),
      ),
    );
    const urlByKey = new Map<string, string>();
    if (keys.length > 0) {
      await Promise.all(
        keys.map(async (k) => {
          const { data } = await db.storage.from("vault").createSignedUrl(k, 300);
          if (data?.signedUrl) urlByKey.set(k, data.signedUrl);
        }),
      );
    }
    const withThumbs = rows.map((r) => {
      const part = r.part as ({ thumbnailKey: string | null } & Record<string, unknown>) | null;
      if (!part) return r;
      const key = part.thumbnailKey;
      return { ...r, part: { ...part, thumbnailUrl: key ? urlByKey.get(key) || null : null } };
    });

    return NextResponse.json(withThumbs);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch BOM items";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Inferred from the zod schema so the validation rules and the TypeScript
// type can never drift out of sync.
type BomItemInput = z.infer<typeof BomItemInputSchema>;

// Snapshot copied from a part (and optionally its primary vendor) onto a
// BOM line at link time. Only fields the client did not explicitly set get
// filled, so manual overrides always win.
//
// Cost precedence: primary vendor's price > part's unitCost.
// Vendor name precedence: primary vendor's name only — `parts` has no vendor
// field of its own, so there's nothing to fall back to.
interface PartSnapshot {
  partNumber: string | null;
  name: string | null;
  description: string | null;
  material: string | null;
  unitCost: number | null;
  unit: string | null;
  vendor: string | null;
}

// Fetch parts AND their primary vendor (one round-trip each), then merge.
// Two queries instead of one nested join because Supabase's PostgREST join
// syntax for "first row matching a filter" is awkward and the dataset here
// is tiny (≤ 1000 parts per bulk insert).
async function fetchPartSnapshots(
  db: ReturnType<typeof getServiceClient>,
  tenantId: string,
  inputs: BomItemInput[]
): Promise<Map<string, PartSnapshot>> {
  const ids = Array.from(new Set(inputs.map((i) => i.partId).filter((v): v is string => !!v)));
  if (ids.length === 0) return new Map();

  const [{ data: parts }, { data: primaryLinks }] = await Promise.all([
    db
      .from("parts")
      .select("id, partNumber, name, description, material, unitCost, unit")
      .eq("tenantId", tenantId)
      .in("id", ids),
    db
      .from("part_vendors")
      .select("partId, unitCost, vendor:vendors!part_vendors_vendorId_fkey(name)")
      .in("partId", ids)
      .eq("isPrimary", true),
  ]);

  // primaryLinks is keyed by partId — each part has at most one primary
  // vendor (enforced by the UI which clears others on insert).
  const primaryByPart = new Map<string, { unitCost: number | null; vendorName: string | null }>();
  for (const row of (primaryLinks || []) as unknown as Array<{ partId: string; unitCost: number | null; vendor: { name: string } | null }>) {
    primaryByPart.set(row.partId, {
      unitCost: row.unitCost,
      vendorName: row.vendor?.name ?? null,
    });
  }

  const map = new Map<string, PartSnapshot>();
  for (const row of (parts || []) as unknown as Array<{ id: string; partNumber: string | null; name: string | null; description: string | null; material: string | null; unitCost: number | null; unit: string | null }>) {
    const primary = primaryByPart.get(row.id);
    map.set(row.id, {
      partNumber: row.partNumber,
      name: row.name,
      description: row.description,
      material: row.material,
      // Primary vendor's price wins over the part's standard cost — this is
      // the standard PDM rollup behavior. Falls through to part.unitCost
      // when there's no primary vendor or the primary has no price set.
      unitCost: primary?.unitCost ?? row.unitCost,
      unit: row.unit,
      vendor: primary?.vendorName ?? null,
    });
  }
  return map;
}

// Fill missing fields on the input from the snapshot. "Missing" means
// undefined OR null OR empty string — any explicit value wins.
const SNAPSHOT_FIELDS = ["partNumber", "name", "description", "material", "unitCost", "unit", "vendor"] as const;

function applyPartSnapshot(input: BomItemInput, snap: PartSnapshot | undefined): BomItemInput {
  if (!snap) return input;
  const out: BomItemInput = { ...input };
  for (const field of SNAPSHOT_FIELDS) {
    const current = out[field];
    if (current === undefined || current === null || current === "") {
      // @ts-expect-error — field is a known key on both types
      out[field] = snap[field];
    }
  }
  return out;
}

function buildItemRow(bomId: string, body: BomItemInput, now: string) {
  return {
    id: uuid(),
    bomId,
    fileId: body.fileId || null,
    partId: body.partId || null,
    linkedBomId: body.linkedBomId || null,
    itemNumber: body.itemNumber || "",
    partNumber: body.partNumber || null,
    name: body.name || "",
    description: body.description || null,
    quantity: body.quantity ?? 1,
    unit: body.unit || "EA",
    level: body.level ?? 1,
    parentItemId: body.parentItemId || null,
    material: body.material || null,
    vendor: body.vendor || null,
    unitCost: body.unitCost ?? null,
    sortOrder: body.sortOrder ?? 0,
    createdAt: now,
    updatedAt: now,
  };
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

    const parsed = await parseBody(request, PostBodySchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const { bomId } = await params;
    const db = getServiceClient();
    const now = new Date().toISOString();

    const guard = await requireBomMutable(db, bomId, tenantUser.tenantId);
    if (!guard.ok) {
      return NextResponse.json({ error: guard.error }, { status: guard.status });
    }

    // Bulk path: schema discriminates on the presence of `items`
    if ("items" in body) {
      const inputs = body.items;
      if (inputs.length === 0) {
        return NextResponse.json({ items: [], inserted: 0 });
      }

      // Cycle check for any sub-assembly links in the batch. Done up
      // front so a single bad row aborts the whole batch instead of
      // landing N-1 rows and failing the cycle row at the end.
      const linkedTargets = Array.from(
        new Set(inputs.map((it) => it.linkedBomId).filter((v): v is string => !!v))
      );
      for (const target of linkedTargets) {
        const check = await checkLinkedBomSafe(db, tenantUser.tenantId, bomId, target);
        if (!check.ok) {
          return NextResponse.json({ error: check.error }, { status: 400 });
        }
      }

      const partSnaps = await fetchPartSnapshots(db, tenantUser.tenantId, inputs);
      const rows = inputs.map((it) =>
        buildItemRow(bomId, applyPartSnapshot(it, partSnaps.get(it.partId || "")), now)
      );
      const { data: inserted, error } = await db.from("bom_items").insert(rows).select();
      if (error) throw error;

      await logAudit({
        tenantId: tenantUser.tenantId, userId: tenantUser.id,
        action: "bom.item.bulk_add", entityType: "bom", entityId: bomId,
        details: { count: inserted?.length ?? 0 },
      });

      return NextResponse.json({ items: inserted, inserted: inserted?.length ?? 0 });
    }

    // Single-item path
    const single = body;
    if (single.linkedBomId) {
      const check = await checkLinkedBomSafe(db, tenantUser.tenantId, bomId, single.linkedBomId);
      if (!check.ok) {
        return NextResponse.json({ error: check.error }, { status: 400 });
      }
    }
    const partSnaps = await fetchPartSnapshots(db, tenantUser.tenantId, [single]);
    const filled = applyPartSnapshot(single, partSnaps.get(single.partId || ""));
    const { data: item, error } = await db
      .from("bom_items")
      .insert(buildItemRow(bomId, filled, now))
      .select()
      .single();

    if (error) throw error;

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "bom.item.add", entityType: "bom", entityId: bomId,
      details: { itemName: single.name || "", itemNumber: single.itemNumber || "" },
    });

    return NextResponse.json(item);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to add BOM item";
    return NextResponse.json({ error: message }, { status: 500 });
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

    const parsed = await parseBody(request, DeleteBodySchema);
    if (!parsed.ok) return parsed.response;
    const { itemId } = parsed.data;

    const { bomId } = await params;
    const db = getServiceClient();

    const guard = await requireBomMutable(db, bomId, tenantUser.tenantId);
    if (!guard.ok) {
      return NextResponse.json({ error: guard.error }, { status: guard.status });
    }

    // Get item name for audit before deleting
    const { data: existing } = await db
      .from("bom_items")
      .select("name, itemNumber")
      .eq("id", itemId)
      .single();

    await db.from("bom_items").delete().eq("id", itemId).eq("bomId", bomId);

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "bom.item.delete", entityType: "bom", entityId: bomId,
      details: { itemName: existing?.name || "", itemNumber: existing?.itemNumber || "" },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete BOM item";
    return NextResponse.json({ error: message }, { status: 500 });
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

    const parsed = await parseBody(request, PutBodySchema);
    if (!parsed.ok) return parsed.response;
    const { itemId, ...rest } = parsed.data;

    const { bomId } = await params;
    const db = getServiceClient();

    const guard = await requireBomMutable(db, bomId, tenantUser.tenantId);
    if (!guard.ok) {
      return NextResponse.json({ error: guard.error }, { status: guard.status });
    }

    // If the update is linking the row to a sub-BOM, refuse cycles
    // before touching the row.
    if (rest.linkedBomId) {
      const check = await checkLinkedBomSafe(db, tenantUser.tenantId, bomId, rest.linkedBomId);
      if (!check.ok) {
        return NextResponse.json({ error: check.error }, { status: 400 });
      }
    }

    // If this update is linking the row to a part, snapshot the part's
    // copyable fields into the update — same rule as POST: only fill fields
    // the client did not explicitly set, so a manual override still wins.
    let effectiveBody: BomItemInput = rest;
    if (rest.partId) {
      const snaps = await fetchPartSnapshots(db, tenantUser.tenantId, [rest]);
      effectiveBody = applyPartSnapshot(rest, snaps.get(rest.partId));
    }

    const updates: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };

    const fields = ["fileId", "partId", "linkedBomId", "itemNumber", "partNumber", "name", "description", "quantity", "unit", "level", "parentItemId", "material", "vendor", "unitCost", "sortOrder"] as const;
    for (const field of fields) {
      if (effectiveBody[field] !== undefined) {
        updates[field] = effectiveBody[field];
      }
    }

    const { data: item, error } = await db
      .from("bom_items")
      .update(updates)
      .eq("id", itemId)
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
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update BOM item";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
