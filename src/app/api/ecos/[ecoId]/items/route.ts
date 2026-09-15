import { v4 as newId } from "uuid";
import { withTenant, badRequest, conflict, notFound } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { nextRevision, revisionTargetProblem } from "@/lib/revision";
import type { ScopedDb } from "@/lib/tenant-db";
import { z, nonEmptyString, optionalString, uuid } from "@/lib/validation";

// An ECO item targets a part (preferred — the part is the PDM's central
// object, and changing a part cascades to its linked files on implement), a
// single file (for loose documents not attached to any part), or a BOM.
// Exactly one — the database CHECK from migration 049 enforces it too; this
// surfaces a clearer error at the API boundary.
const AddEcoItemSchema = z
  .object({
    partId: z.string().trim().min(1).optional(),
    fileId: z.string().trim().min(1).optional(),
    /**
     * A change order governs an item AND its structure — that is what makes
     * it a change order. Before migration 046 an ECO could carry the part
     * revision but not the BOM revision that went with it.
     */
    bomId: z.string().trim().min(1).optional(),
    changeType: z.enum(["ADD", "MODIFY", "REMOVE"]),
    reason: optionalString,
    fromRevision: optionalString,
    /**
     * For a part, the revision it becomes. Optional: left blank, submitting
     * the ECO works it out by the rules in lib/revision.ts and writes it here.
     */
    toRevision: optionalString,
  })
  .refine((v) => (v.partId ? 1 : 0) + (v.fileId ? 1 : 0) + (v.bomId ? 1 : 0) === 1, {
    message: "Provide exactly one of partId, fileId or bomId",
    path: ["partId"],
  });

const RemoveEcoItemSchema = z.object({ itemId: nonEmptyString });

const ParamsSchema = z.object({ ecoId: uuid });

const ITEM_COLUMNS =
  "id, ecoId, partId, fileId, bomId, changeType, reason, fromRevision, toRevision";

// We deliberately do NOT use PostgREST embed hints like
// `part:parts!eco_items_partId_fkey(...)` here. Those were silently
// coming back null — the joined rows never materialized — which
// manifested as "Affected Items is empty even though eco_items has
// rows in the DB". Rather than chase the schema-cache / constraint
// name the resolver was unhappy about, just fetch the raw item rows
// and hydrate the part/file sides with batched selects.
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
  bomId: string | null;
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
  bom: {
    id: string;
    name: string;
    revision: string;
    status: string;
  } | null;
};

/** Parts, files and BOMs are tenant tables, so the scoped client filters each read. */
async function hydrateItems(db: ScopedDb, rows: RawItem[]): Promise<HydratedItem[]> {
  const ids = (key: "partId" | "fileId" | "bomId") =>
    Array.from(new Set(rows.map((r) => r[key]).filter((v): v is string => !!v)));
  const partIds = ids("partId");
  const fileIds = ids("fileId");
  const bomIds = ids("bomId");
  const none = Promise.resolve({ data: [], error: null });

  const [partsRes, filesRes, bomsRes] = await Promise.all([
    partIds.length
      ? db
          .from("parts")
          .select("id, partNumber, name, revision, lifecycleState, category")
          .in("id", partIds)
      : none,
    fileIds.length
      ? db
          .from("files")
          .select("id, name, partNumber, lifecycleState, currentVersion")
          .in("id", fileIds)
      : none,
    bomIds.length ? db.from("boms").select("id, name, revision, status").in("id", bomIds) : none,
  ]);

  if (partsRes.error) throw new Error(`Could not load the ECO's parts: ${partsRes.error.message}`);
  if (filesRes.error) throw new Error(`Could not load the ECO's files: ${filesRes.error.message}`);
  if (bomsRes.error) throw new Error(`Could not load the ECO's BOMs: ${bomsRes.error.message}`);

  const byId = <T extends { id: string }>(list: T[] | null) =>
    new Map((list ?? []).map((row) => [row.id, row] as const));
  const partById = byId<NonNullable<HydratedItem["part"]>>(partsRes.data);
  const fileById = byId<NonNullable<HydratedItem["file"]>>(filesRes.data);
  const bomById = byId<NonNullable<HydratedItem["bom"]>>(bomsRes.data);

  return rows.map((r) => ({
    ...r,
    part: r.partId ? (partById.get(r.partId) ?? null) : null,
    file: r.fileId ? (fileById.get(r.fileId) ?? null) : null,
    bom: r.bomId ? (bomById.get(r.bomId) ?? null) : null,
  }));
}

/** The ECO, through the scoped client, so every item query below is keyed by an ECO in this tenant. */
async function loadEco(db: ScopedDb, ecoId: string) {
  const { data: eco, error } = await db
    .from("ecos")
    .select("id, status, ecoNumber")
    .eq("id", ecoId)
    .is("deletedAt", null)
    .maybeSingle();
  if (error) throw new Error(`Could not load the ECO: ${error.message}`);
  if (!eco) throw notFound("ECO not found");
  return eco as { id: string; status: string; ecoNumber: string };
}

/**
 * Why a part item cannot name this revision, or null.
 *
 * An explicit "To revision" was never checked, so a part at C could be put on
 * an ECO to become C, or B; and a blank one was left for `implement_eco` to
 * bump with `chr(ascii + 1)`, which raised on revisions like R3-1 or Z and
 * stranded the approved ECO (AUD-003 CHG-3). Saying so while the item is
 * being added is the cheapest place to fix it.
 */
function partRevisionRefusal(
  part: { partNumber: string; revision: string | null },
  toRevision: string | null | undefined
): string | null {
  const current = (part.revision ?? "").trim();
  if (toRevision) {
    const problem = revisionTargetProblem(current, toRevision);
    if (problem === "same") {
      return `${part.partNumber} is already at revision ${current}. Enter the revision it will become.`;
    }
    if (problem === "earlier") {
      return `${part.partNumber} is at revision ${current}, and ${toRevision} comes before it. Enter a later revision.`;
    }
    return null;
  }
  if (nextRevision(current)) return null;
  return current
    ? `${part.partNumber} is at revision ${current}, which cannot be followed on from automatically. Enter the revision it will become.`
    : `${part.partNumber} has no revision yet. Enter the revision it will become.`;
}

export const GET = withTenant({ params: ParamsSchema }, async ({ db, params }) => {
  const eco = await loadEco(db, params.ecoId);

  // lint-conventions-allow: child-table-direct-query — keyed by an ECO just
  // loaded through the scoped client.
  const { data: rawItems, error } = await db
    .from("eco_items")
    .select(ITEM_COLUMNS)
    .eq("ecoId", eco.id)
    .order("id", { ascending: true });
  if (error) throw new Error(`Query failed: ${error.message}`);

  return hydrateItems(db, (rawItems ?? []) as RawItem[]);
});

export const POST = withTenant(
  { permission: PERMISSIONS.ECO_EDIT, body: AddEcoItemSchema, params: ParamsSchema },
  async ({ db, tenantUser, params, body }) => {
    const { partId, fileId, bomId, changeType, reason, fromRevision, toRevision } = body;

    const eco = await loadEco(db, params.ecoId);
    if (eco.status !== "DRAFT") throw badRequest("Can only add items to DRAFT ECOs");

    /** An item already on this ECO for the same target. */
    async function alreadyOnEco(column: "partId" | "fileId" | "bomId", id: string) {
      // lint-conventions-allow: child-table-direct-query — keyed by the ECO
      // loaded above.
      const { data, error } = await db
        .from("eco_items")
        .select("id")
        .eq("ecoId", eco.id)
        .eq(column, id)
        .limit(1);
      if (error) throw new Error(`Could not check the ECO's items: ${error.message}`);
      return (data ?? []).length > 0;
    }

    // The target must be in the caller's tenant, which the scoped client
    // guarantees, and not in the trash. Parts and BOMs seed fromRevision when
    // the caller did not, so the history explains itself.
    let seededFromRevision: string | null = fromRevision ?? null;
    if (partId) {
      const { data: part } = await db
        .from("parts")
        .select("id, partNumber, revision, deletedAt")
        .eq("id", partId)
        .maybeSingle();
      if (!part || part.deletedAt) throw notFound("Part not found");

      const refusal = partRevisionRefusal(part, toRevision);
      if (refusal) throw badRequest(refusal);

      if (!seededFromRevision) seededFromRevision = part.revision;
      if (await alreadyOnEco("partId", partId)) {
        throw conflict("This part is already in this ECO");
      }
    } else if (fileId) {
      const { data: file } = await db
        .from("files")
        .select("id, deletedAt")
        .eq("id", fileId)
        .maybeSingle();
      if (!file || file.deletedAt) throw notFound("File not found");
      if (await alreadyOnEco("fileId", fileId)) {
        throw conflict("This file is already in this ECO");
      }
    } else if (bomId) {
      const { data: bom } = await db
        .from("boms")
        .select("id, revision, deletedAt")
        .eq("id", bomId)
        .maybeSingle();
      if (!bom || bom.deletedAt) throw notFound("BOM not found");
      if (!seededFromRevision) seededFromRevision = bom.revision;
      if (await alreadyOnEco("bomId", bomId)) {
        throw conflict("This BOM is already in this ECO");
      }
    }

    // lint-conventions-allow: child-table-direct-query — the row's ecoId is the
    // ECO loaded above, and every target was checked against the tenant.
    const { data: rawItem, error } = await db
      .from("eco_items")
      .insert({
        id: newId(),
        ecoId: eco.id,
        partId: partId ?? null,
        fileId: fileId ?? null,
        bomId: bomId ?? null,
        changeType,
        reason: reason ?? null,
        fromRevision: seededFromRevision,
        toRevision: toRevision ?? null,
      })
      .select(ITEM_COLUMNS)
      .single();
    if (error) throw new Error(`Could not add the item: ${error.message}`);

    const [item] = await hydrateItems(db, [rawItem as RawItem]);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "eco.item.added",
      entityType: "eco",
      entityId: eco.id,
      details: {
        ecoNumber: eco.ecoNumber,
        target: partId ? "part" : fileId ? "file" : "bom",
        partId: partId ?? null,
        fileId: fileId ?? null,
        bomId: bomId ?? null,
        changeType,
        toRevision: toRevision ?? null,
      },
    });

    return item;
  }
);

export const DELETE = withTenant(
  { permission: PERMISSIONS.ECO_EDIT, body: RemoveEcoItemSchema, params: ParamsSchema },
  async ({ db, tenantUser, params, body }) => {
    const eco = await loadEco(db, params.ecoId);
    if (eco.status !== "DRAFT") throw badRequest("Can only remove items from DRAFT ECOs");

    // lint-conventions-allow: child-table-direct-query — keyed by the ECO
    // loaded above as well as the item, so an item id from another ECO
    // matches nothing.
    const { error } = await db.from("eco_items").delete().eq("id", body.itemId).eq("ecoId", eco.id);
    if (error) throw conflict(`Could not remove item: ${error.message}`);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "eco.item.removed",
      entityType: "eco",
      entityId: eco.id,
      details: { ecoNumber: eco.ecoNumber, itemId: body.itemId },
    });

    return { success: true };
  }
);
