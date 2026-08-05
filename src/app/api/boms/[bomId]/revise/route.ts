import { v4 as uuid } from "uuid";
import { withTenant, notFound, conflict, badRequest } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { nextRevision } from "@/lib/revision";
import { z, uuid as uuidSchema, optionalString } from "@/lib/validation";

/**
 * POST /api/boms/[bomId]/revise
 *
 * Start the next revision of a released BOM.
 *
 * This closes the workflow's one dead end. `BOM_STATUS_FLOW` allows
 * RELEASED → OBSOLETE and nothing after it, and the items route refuses
 * edits on either — so releasing a BOM used to make it permanently
 * unchangeable. Files have had revise-on-reopen all along; BOMs simply
 * never got it.
 *
 * **A revision is a new object, not a mutation.** Revision A keeps its
 * status, its items and its baseline; B is created in DRAFT as a copy, with
 * `previousRevisionId` pointing back. That is how PLM systems model it, and
 * it is what makes a released document that cites revision A stay true.
 *
 * Two things this deliberately does NOT do:
 *
 *   - **Repoint parents.** A parent BOM that cites revision A goes on citing
 *     revision A, because that is what its own release said. Moving a parent
 *     onto a new child revision changes the parent, and therefore wants its
 *     own ECO.
 *   - **Supersede A immediately.** `supersededById` is set when B is
 *     released, not when it is drafted. Until then A is still the current
 *     revision, because it is still the one in effect.
 */

const ParamsSchema = z.object({ bomId: uuidSchema });

const BodySchema = z.object({
  /**
   * Override the computed revision. Needed when the current one cannot be
   * sequenced, and useful when a shop jumps revisions deliberately.
   */
  revision: optionalString,
  ecoId: z.string().uuid().optional(),
});

export const POST = withTenant(
  { permission: PERMISSIONS.FILE_EDIT, params: ParamsSchema, body: BodySchema },
  async ({ db, tenantUser, params, body }) => {
    const { data: source } = await db
      .from("boms")
      .select("*")
      .eq("id", params.bomId)
      .is("deletedAt", null)
      .maybeSingle();
    if (!source) throw notFound("BOM not found");

    // Revising is what you do to something that has been issued. A DRAFT is
    // still editable in place, so a second revision of it would be two live
    // drafts of the same thing and no way to say which is meant.
    if (source.status !== "RELEASED" && source.status !== "OBSOLETE") {
      throw conflict(
        `Only a released BOM can be revised — this one is ${source.status}. ` +
          `Edit it directly instead.`
      );
    }

    if (source.supersededById) {
      throw conflict(
        "This revision has already been superseded. Revise the current revision instead."
      );
    }

    // An open revision already in flight is the common mistake: two people
    // each start B from A and neither knows about the other.
    const { data: openRevisions } = await db
      .from("boms")
      .select("id, revision, status")
      .eq("previousRevisionId", params.bomId)
      .is("deletedAt", null);
    if ((openRevisions ?? []).length > 0) {
      const open = (openRevisions as unknown as Array<{ revision: string }>)[0];
      throw conflict(
        `Revision ${open.revision} has already been started from this one. ` +
          `Finish or delete it before starting another.`
      );
    }

    const computed = nextRevision(source.revision as string);
    const revision = body.revision?.trim() || computed?.next;
    if (!revision) {
      throw badRequest(
        `Cannot work out the revision after "${source.revision}". ` +
          `Supply the next revision explicitly.`
      );
    }

    const now = new Date().toISOString();
    const newBomId = uuid();

    const { error: insertError } = await db.from("boms").insert({
      id: newBomId,
      name: source.name,
      revision,
      status: "DRAFT",
      fileId: source.fileId ?? null,
      partId: source.partId ?? null,
      previousRevisionId: params.bomId,
      createdById: tenantUser.id,
      createdAt: now,
      updatedAt: now,
    });
    if (insertError) {
      // The unique index on (tenantId, name, revision) is what catches two
      // people revising to the same letter at once.
      if (insertError.code === "23505") {
        throw conflict(`A BOM named "${source.name}" at revision ${revision} already exists.`);
      }
      throw new Error(insertError.message);
    }

    // Copy the structure. Options, links and quantities all carry over —
    // a revision starts as what it was, and the point is to then change it.
    // lint-conventions-allow: child-table-direct-query — `bom_items` has no
    // tenantId; read by the source BOM's id, which came from the scoped read
    // above, and written against a BOM this handler just created.
    const { data: sourceItems } = await db
      .from("bom_items")
      .select("*")
      .eq("bomId", params.bomId)
      .order("sortOrder");

    const items = (sourceItems ?? []) as unknown as Array<Record<string, unknown>>;
    if (items.length > 0) {
      const copies = items.map((item) => ({
        ...item,
        id: uuid(),
        bomId: newBomId,
        createdAt: now,
        updatedAt: now,
      }));
      // lint-conventions-allow: child-table-direct-query — see above.
      const { error } = await db.from("bom_items").insert(copies);
      if (error) throw new Error(error.message);
    }

    if (body.ecoId) {
      // lint-conventions-allow: child-table-direct-query — `eco_items` is
      // reached through its ECO; the id is validated as a UUID and the FK
      // rejects one from another tenant.
      const { error } = await db.from("eco_items").insert({
        id: uuid(),
        ecoId: body.ecoId,
        bomId: newBomId,
        // NOT NULL, and omitting it failed every call with 23502. A revision
        // of an existing BOM is a MODIFY; the row is created by revising, so
        // there is no case here where it is an ADD or a REMOVE.
        changeType: "MODIFY",
        fromRevision: source.revision,
        toRevision: revision,
        // No `createdAt` — `eco_items` has no such column, and writing it
        // failed every call with PGRST204 before the NOT NULL above was
        // even reached. Both were masked by the soft-warning path below.
      });
      // A bad ECO id should not cost the caller the revision they just
      // created, so this is reported rather than thrown.
      //
      // But log it as an error too. This branch was written for "the user
      // typed a bad ECO id" and instead absorbed two schema faults that made
      // it fire on *every* call — a 23514 CHECK violation, then a PGRST204
      // and a 23502 — for a day, while the response still read as a mild
      // note. A soft failure path needs something that notices when it stops
      // being rare, and a server-side error log is the cheapest version.
      if (error) {
        console.error(
          `[boms/${params.bomId}/revise] could not link revision ${newBomId} ` +
            `to ECO ${body.ecoId}: ${error.code ?? "?"} ${error.message}`
        );
        return {
          id: newBomId,
          name: source.name,
          revision,
          previousRevisionId: params.bomId,
          itemsCopied: items.length,
          warning: `Revision created, but it could not be linked to the ECO: ${error.message}`,
        };
      }
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "bom.revise",
      entityType: "bom",
      entityId: newBomId,
      details: {
        name: source.name as string,
        fromRevision: source.revision as string,
        toRevision: revision,
        itemsCopied: items.length,
      },
    });

    return {
      id: newBomId,
      name: source.name,
      revision,
      previousRevisionId: params.bomId,
      itemsCopied: items.length,
    };
  }
);
