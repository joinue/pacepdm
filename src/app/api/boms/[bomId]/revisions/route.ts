import { withTenant, notFound } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { z, uuid } from "@/lib/validation";

/**
 * GET /api/boms/[bomId]/revisions
 *
 * The revision lineage this BOM belongs to, oldest first.
 *
 * `previousRevisionId` and `supersededById` have made the chain walkable
 * since migration 046, and nothing walked it. That was survivable while the
 * only way to create a link was by hand; it stopped being survivable when
 * `implement_eco` started setting `supersededById` itself (migration 049),
 * because the chain now fills up on its own and a superseded revision is
 * filtered out of `GET /api/boms` — reachable only by typing its id into
 * the URL.
 *
 * Returns every revision in the chain, not just the ones before this one, so
 * the same response serves both directions: "what came before this" on a
 * current revision, and "what replaced this" on a superseded one.
 */

const ParamsSchema = z.object({ bomId: uuid });

/**
 * Chains are short — a BOM at revision Z has 25 ancestors — but a corrupt
 * `previousRevisionId` cycle would otherwise spin forever against the
 * database. Bounded well above any real revision count.
 */
const MAX_CHAIN = 200;

interface ChainRow {
  id: string;
  name: string;
  revision: string;
  status: string;
  previousRevisionId: string | null;
  supersededById: string | null;
  createdAt: string;
  updatedAt: string;
  createdById: string | null;
}

export const GET = withTenant(
  { permission: PERMISSIONS.FILE_VIEW, params: ParamsSchema },
  async ({ db, params }) => {
    const SELECT =
      "id, name, revision, status, previousRevisionId, supersededById, createdAt, updatedAt, createdById";

    const { data: startRow } = await db
      .from("boms")
      .select(SELECT)
      .eq("id", params.bomId)
      .is("deletedAt", null)
      .maybeSingle();
    if (!startRow) throw notFound("BOM not found");

    const start = startRow as unknown as ChainRow;
    const seen = new Set<string>([start.id]);

    // Walk back to the root. `seen` guards the cycle case rather than
    // relying on MAX_CHAIN alone, so a two-row loop terminates immediately
    // instead of after 200 round trips.
    const ancestors: ChainRow[] = [];
    let cursor: string | null = start.previousRevisionId;
    for (let i = 0; cursor && i < MAX_CHAIN; i++) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const { data } = await db
        .from("boms")
        .select(SELECT)
        .eq("id", cursor)
        .is("deletedAt", null)
        .maybeSingle();
      if (!data) break; // deleted ancestor — the chain simply starts later
      const row = data as unknown as ChainRow;
      ancestors.push(row);
      cursor = row.previousRevisionId;
    }

    // Walk forward. The successor is whichever live BOM points back at this
    // one; `revise` refuses to start a second open revision from the same
    // source, so in practice there is at most one. If data ever does branch,
    // take the oldest so the result is deterministic rather than arbitrary.
    const descendants: ChainRow[] = [];
    let head: string | null = start.id;
    for (let i = 0; head && i < MAX_CHAIN; i++) {
      const { data } = await db
        .from("boms")
        .select(SELECT)
        .eq("previousRevisionId", head)
        .is("deletedAt", null)
        .order("createdAt", { ascending: true })
        .limit(1);
      const next = (data ?? [])[0] as unknown as ChainRow | undefined;
      if (!next || seen.has(next.id)) break;
      seen.add(next.id);
      descendants.push(next);
      head = next.id;
    }

    // Order comes from the walk itself, not from `createdAt`. Timestamps tie
    // — a bulk import writes many rows in the same millisecond — and a tie
    // would order two revisions arbitrarily, which is the one thing a
    // revision history must never do. The links are the ordering.
    const chain = [...ancestors.reverse(), start, ...descendants];

    // The ECO that governed each step, where there was one. A BOM's first
    // release often has no change order behind it, so this is frequently
    // null and that is not a gap.
    //
    // lint-conventions-allow: child-table-direct-query — `eco_items` has no
    // tenantId; read by the BOM ids resolved above, every one of which came
    // through the tenant-scoped client.
    const { data: ecoLinks } = await db
      .from("eco_items")
      .select(
        "bomId, fromRevision, toRevision, eco:ecos!eco_items_ecoId_fkey(id, ecoNumber, title, status, implementedAt)"
      )
      .in(
        "bomId",
        chain.map((c) => c.id)
      );

    type EcoRef = {
      id: string;
      ecoNumber: string;
      title: string;
      status: string;
      implementedAt: string | null;
    };
    const ecoByBom = new Map<string, EcoRef>();
    for (const link of ecoLinks ?? []) {
      const eco = link.eco as unknown as EcoRef | null;
      if (eco && link.bomId) ecoByBom.set(link.bomId as string, eco);
    }

    // Author names, resolved in one round trip.
    const authorIds = [...new Set(chain.map((c) => c.createdById).filter((v): v is string => !!v))];
    const authorById = new Map<string, string | null>();
    if (authorIds.length > 0) {
      const { data: users } = await db
        .from("tenant_users")
        .select("id, fullName")
        .in("id", authorIds);
      for (const u of users ?? []) authorById.set(u.id as string, (u.fullName as string) ?? null);
    }

    return chain.map((c) => ({
      id: c.id,
      name: c.name,
      revision: c.revision,
      status: c.status,
      createdAt: c.createdAt,
      // A released revision's `updatedAt` is when it was released; that is
      // the date people mean by "when did this revision take effect". Only
      // meaningful once released, so it is null before that.
      releasedAt: c.status === "RELEASED" || c.status === "OBSOLETE" ? c.updatedAt : null,
      createdByName: c.createdById ? (authorById.get(c.createdById) ?? null) : null,
      supersededById: c.supersededById,
      isCurrent: c.supersededById === null,
      isRequested: c.id === params.bomId,
      eco: ecoByBom.get(c.id) ?? null,
    }));
  }
);
