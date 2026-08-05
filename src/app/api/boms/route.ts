import { withTenant } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { v4 as uuidv4 } from "uuid";
import { z, nonEmptyString } from "@/lib/validation";
import { looseKey } from "@/lib/bom-import";

const CreateBomSchema = z.object({
  name: nonEmptyString,
});

/**
 * GET /api/boms
 *
 * Each BOM carries `usedIn`: the BOMs that reference it as a sub-assembly.
 * Without it the list has no way to tell a product from a component, and
 * renders 26 equal-looking rows when 25 of them are children of one machine
 * — which is what the NANO-1000S import produced.
 *
 * A BOM with an empty `usedIn` is top-level. That is a derived fact, not a
 * flag anyone maintains, so it cannot drift from the actual structure. It
 * also makes a broken link visible: a sub-assembly whose parent references
 * it under a misspelt name has no parents and surfaces as a product.
 */
export const GET = withTenant({}, async ({ db }) => {
  const { data } = await db
    .from("boms")
    .select("*")
    .is("deletedAt", null)
    .order("createdAt", { ascending: false })
    .limit(500);

  const boms = (data ?? []) as unknown as Array<{ id: string; name: string }>;
  if (boms.length === 0) return [];

  // `bom_items` has no tenantId, so it is queried by the parent ids we just
  // read through the scoped client rather than filtered directly.
  // lint-conventions-allow: child-table-direct-query — scoped by `bomId` in
  // the id set above, every one of which came from the tenant-scoped read.
  const { data: rows } = await db
    .from("bom_items")
    .select("bomId, linkedBomId, partNumber")
    .in(
      "bomId",
      boms.map((b) => b.id)
    );

  const items = (rows ?? []) as unknown as Array<{
    bomId: string;
    linkedBomId: string | null;
    partNumber: string | null;
  }>;

  const nameById = new Map(boms.map((b) => [b.id, b.name]));
  const usedIn = new Map<string, { id: string; name: string }[]>();
  // Every part number referenced by a line that did NOT resolve to a BOM,
  // keyed loosely. A top-level BOM whose name collides with one of these is
  // almost certainly a link broken by a typo.
  const unlinkedRefs = new Map<string, string>();

  for (const item of items) {
    if (item.linkedBomId) {
      const parents = usedIn.get(item.linkedBomId) ?? [];
      // A parent that lists the same child on two lines is still one parent.
      if (!parents.some((p) => p.id === item.bomId)) {
        parents.push({ id: item.bomId, name: nameById.get(item.bomId) ?? item.bomId });
      }
      usedIn.set(item.linkedBomId, parents);
    } else if (item.partNumber) {
      unlinkedRefs.set(looseKey(item.partNumber), item.partNumber);
    }
  }

  return boms.map((b) => {
    const parents = usedIn.get(b.id) ?? [];
    const nearMiss = parents.length === 0 ? unlinkedRefs.get(looseKey(b.name)) : undefined;
    return {
      ...b,
      usedIn: parents,
      // Set only when this BOM has no parents but something references a
      // name that differs from it only in punctuation or case.
      orphanHint: nearMiss && nearMiss !== b.name ? nearMiss : null,
    };
  });
});

export const POST = withTenant(
  { permission: PERMISSIONS.FILE_EDIT, body: CreateBomSchema },
  async ({ db, tenantUser, body, request }) => {
    const now = new Date().toISOString();
    const idempotencyKey = request.headers.get("idempotency-key") || null;

    // Idempotency: if the client sent a key and a BOM with that key
    // already exists for this tenant, return it instead of creating a
    // duplicate. Prevents double-creation on network retries.
    if (idempotencyKey) {
      const { data: existing } = await db
        .from("boms")
        .select("*")
        .eq("clientRequestKey", idempotencyKey)
        .maybeSingle();
      if (existing) return existing;
    }

    const { data: bom, error } = await db
      .from("boms")
      .insert({
        id: uuidv4(),
        name: body.name,
        revision: "A",
        status: "DRAFT",
        createdById: tenantUser.id,
        clientRequestKey: idempotencyKey,
        createdAt: now,
        updatedAt: now,
      })
      .select()
      .single();

    if (error) {
      // Race: another request with the same key landed first
      if (error.code === "23505" && idempotencyKey) {
        const { data: existing } = await db
          .from("boms")
          .select("*")
          .eq("clientRequestKey", idempotencyKey)
          .maybeSingle();
        if (existing) return existing;
      }
      throw new Error(error.message);
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "bom.create",
      entityType: "bom",
      entityId: bom.id,
      details: { name: body.name },
    });

    return bom;
  }
);
