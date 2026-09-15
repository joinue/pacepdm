import { withTenant, notFound, badRequest, conflict } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { looseKey } from "@/lib/bom-import";
import { wouldCreateCycle, type RollupBom } from "@/lib/bom-rollup";
import { findBomContentLocks } from "@/lib/bom-lock";
import { z, uuid } from "@/lib/validation";

/**
 * POST /api/boms/[bomId]/relink
 *
 * Repairs sub-assembly links broken by a typo in the source data.
 *
 * Links are made by exact part-number match, so one wrong character demotes
 * an assembly to a leaf: the referencing line becomes an ordinary part, and
 * the BOM it should have pointed at is left with no parents. The NANO-1000S
 * build list has exactly this — `NANO-1000S` references
 * `NANO1000S Casting-Components`, missing a hyphen, so
 * `NANO-1000S Casting-Components` sits at the top level looking like a
 * product.
 *
 * The importer warns about it at import time and the BOM list flags it
 * afterwards, but until now neither offered a way to fix it — the only
 * route was to delete the line and re-add it as a sub-assembly by hand, per
 * broken link. This closes that loop.
 *
 * Conservative by construction. It repairs a line only when ALL of:
 *
 *   - the line has no `linkedBomId` (never re-points an existing link);
 *   - its part number matches this BOM's name ignoring punctuation and case
 *     only — the same `looseKey` the importer uses, so `N1S-P-005` is never
 *     confused with `N1S-P-006`;
 *   - the resulting link does not close a cycle;
 *   - the BOM the line sits on is not locked (lib/bom-lock.ts). A released
 *     or obsolete BOM is issued, and one carried by an in-flight ECO has to
 *     reach implementation exactly as it was reviewed. A repair is still a
 *     change to that BOM's lines, so those lines are skipped and reported
 *     rather than rewritten.
 *
 * Returns what it changed, what it skipped and why, and names the
 * now-unreferenced phantom parts without deleting them: removing a part is a
 * decision for a person.
 */

const ParamsSchema = z.object({ bomId: uuid });

interface RepairedLine {
  bomId: string;
  bomName: string;
  itemId: string;
  itemNumber: string;
  /** The misspelt part number that was on the line. */
  wasPartNumber: string;
}

interface SkippedLine {
  bomId: string;
  bomName: string;
  itemId: string;
  itemNumber: string;
  /** Why the BOM the line sits on could not be changed. */
  reason: string;
}

export const POST = withTenant(
  { permission: PERMISSIONS.FILE_EDIT, params: ParamsSchema },
  async ({ db, tenantUser, params }) => {
    const { data: target } = await db
      .from("boms")
      .select("id, name, deletedAt")
      .eq("id", params.bomId)
      .is("deletedAt", null)
      .maybeSingle();
    if (!target) throw notFound("BOM not found");

    const targetName = target.name as string;
    const targetKey = looseKey(targetName);

    // Every BOM in the tenant, so candidate lines can be found and the cycle
    // check has the graph it needs.
    const { data: bomRows } = await db
      .from("boms")
      .select("id, name, revision, status")
      .is("deletedAt", null);
    const boms = (bomRows ?? []) as unknown as Array<{
      id: string;
      name: string;
      revision: string;
      status: string;
    }>;
    const bomIds = boms.map((b) => b.id);
    if (bomIds.length === 0) throw notFound("BOM not found");

    // lint-conventions-allow: child-table-direct-query — `bom_items` has no
    // tenantId; scoped by `bomId` in the id set above, every one of which
    // came from the tenant-scoped read.
    const { data: itemRows } = await db
      .from("bom_items")
      .select("id, bomId, linkedBomId, itemNumber, partNumber, name, quantity, unit, unitCost")
      .in("bomId", bomIds);
    const items = (itemRows ?? []) as unknown as Array<{
      id: string;
      bomId: string;
      linkedBomId: string | null;
      itemNumber: string | null;
      partNumber: string | null;
      name: string | null;
      quantity: number | null;
      unit: string | null;
      unitCost: number | null;
    }>;

    // Candidates: unlinked lines whose part number is a near miss of this
    // BOM's name, and which are not already spelled correctly (an exact
    // match that is still unlinked is a different bug, and not this route's
    // business to guess at).
    const candidates = items.filter(
      (i) =>
        !i.linkedBomId &&
        i.partNumber !== null &&
        i.partNumber !== targetName &&
        looseKey(i.partNumber) === targetKey
    );

    if (candidates.length === 0) {
      throw badRequest(
        `Nothing to relink. No unlinked line references a near-miss of "${targetName}".`
      );
    }

    // Lines on a locked BOM are left alone. If that is every candidate, there
    // is nothing this call may do, and saying so beats a 200 that changed
    // nothing.
    const parentIds = new Set(candidates.map((c) => c.bomId));
    const locks = await findBomContentLocks(
      db,
      tenantUser.tenantId,
      boms.filter((b) => parentIds.has(b.id))
    );
    const skipped: SkippedLine[] = [];
    const repairable = candidates.filter((c) => {
      const lock = locks.get(c.bomId);
      if (!lock) return true;
      skipped.push({
        bomId: c.bomId,
        bomName: boms.find((b) => b.id === c.bomId)?.name ?? c.bomId,
        itemId: c.id,
        itemNumber: c.itemNumber ?? "",
        reason: lock.message,
      });
      return false;
    });

    if (repairable.length === 0) {
      throw conflict(
        `Nothing was relinked. Every line referencing a near-miss of "${targetName}" ` +
          `is on a BOM that cannot be changed: ` +
          skipped.map((s) => `${s.bomName} — ${s.reason}`).join(" "),
        { skipped }
      );
    }

    // Cycle guard, run against the graph as it stands. Linking a parent into
    // its own descendant would make the rollup non-terminating.
    const bomsById = new Map<string, RollupBom>();
    for (const b of boms) {
      bomsById.set(b.id, {
        id: b.id,
        name: b.name,
        revision: b.revision,
        items: items
          .filter((i) => i.bomId === b.id)
          .map((i) => ({
            id: i.id,
            bomId: i.bomId,
            linkedBomId: i.linkedBomId,
            itemNumber: i.itemNumber ?? "",
            partNumber: i.partNumber,
            name: i.name ?? "",
            quantity: i.quantity ?? 0,
            unit: i.unit ?? "EA",
            unitCost: i.unitCost,
          })),
      });
    }

    for (const candidate of repairable) {
      const cycle = wouldCreateCycle(candidate.bomId, params.bomId, bomsById);
      if (cycle) {
        throw conflict(
          `Linking "${targetName}" into "${bomsById.get(candidate.bomId)?.name}" would create a cycle: ${cycle.join(" → ")}`
        );
      }
    }

    // The correctly-named part for this BOM, if one exists — the importer
    // creates one per BOM. Repointing `partId` too keeps the line's part
    // reference consistent with its new link.
    const { data: correctPart } = await db
      .from("parts")
      .select("id")
      .eq("partNumber", targetName)
      .is("deletedAt", null)
      .maybeSingle();

    const repaired: RepairedLine[] = [];
    const now = new Date().toISOString();

    for (const candidate of repairable) {
      const patch: Record<string, unknown> = {
        linkedBomId: params.bomId,
        partNumber: targetName,
        updatedAt: now,
      };
      if (correctPart?.id) patch.partId = correctPart.id;

      // lint-conventions-allow: child-table-direct-query — updating by the
      // item's own id, read a moment ago from the tenant-scoped id set.
      const { error } = await db.from("bom_items").update(patch).eq("id", candidate.id);
      if (error) throw new Error(error.message);

      repaired.push({
        bomId: candidate.bomId,
        bomName: bomsById.get(candidate.bomId)?.name ?? candidate.bomId,
        itemId: candidate.id,
        itemNumber: candidate.itemNumber ?? "",
        wasPartNumber: candidate.partNumber!,
      });
    }

    // The misspelt part numbers the lines used to carry. If nothing else
    // references them they are phantoms left by the import, but that is for
    // a person to confirm — a part may legitimately exist under that name.
    // A skipped line still carries its misspelling, so it still counts as a use.
    const freed = [...new Set(repaired.map((r) => r.wasPartNumber))];
    const stillUsed = new Set(
      items
        .filter((i) => !repaired.some((r) => r.itemId === i.id))
        .map((i) => i.partNumber)
        .filter((p): p is string => p !== null)
    );
    const orphanedParts = freed.filter((p) => !stillUsed.has(p));

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "bom.relink",
      entityType: "bom",
      entityId: params.bomId,
      details: {
        name: targetName,
        linesRepaired: repaired.length,
        parents: repaired.map((r) => r.bomName).join(", "),
        linesSkipped: skipped.length,
      },
    });

    return {
      bomName: targetName,
      repaired,
      /** Lines left alone because their BOM is locked, with the reason. */
      skipped,
      /** Part numbers no BOM line references any more. Not deleted. */
      orphanedParts,
    };
  }
);
