import { v4 as newId } from "uuid";
import { withTenant, badRequest, notFound } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { notify, sideEffect } from "@/lib/notifications";
import { LEAD_TIME_OPTIONS, isLeadTime } from "@/lib/lead-times";
import { z, optionalString, uuid } from "@/lib/validation";

/**
 * Stating what a machine's lead time is today.
 *
 * The write does four things at once, and all four are the reason this is not
 * a spreadsheet: it stamps who said it and when, it keeps what the value was
 * in `equipment_lead_time_changes`, it writes an audit row, and it tells the
 * workspace. A sheet overwrites, "who told sales six weeks" has no answer, and
 * nobody hears about a change until they open it.
 */

const UpdateSchema = z
  .object({
    /** One of LEAD_TIME_OPTIONS, or null to say nobody knows yet. */
    currentLeadTime: z.string().nullable().optional(),
    typicalLeadTime: z.string().nullable().optional(),
    description: optionalString,
    notes: optionalString,
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No changes specified" });

const ParamsSchema = z.object({ leadTimeId: uuid });

const COLUMNS =
  "id, model, description, typicalLeadTime, currentLeadTime, notes, updatedAt, " +
  "updatedBy:tenant_users!equipment_lead_times_updatedById_fkey(fullName)";

function checkOption(value: string | null | undefined, field: string) {
  if (value === null || value === undefined) return;
  if (!isLeadTime(value)) {
    throw badRequest(`"${value}" is not one of the lead times sales quotes.`, {
      field,
      options: LEAD_TIME_OPTIONS,
    });
  }
}

export const PUT = withTenant(
  { permission: PERMISSIONS.LEAD_TIME_EDIT, body: UpdateSchema, params: ParamsSchema },
  async ({ db, tenantUser, params, body }) => {
    checkOption(body.currentLeadTime, "currentLeadTime");
    checkOption(body.typicalLeadTime, "typicalLeadTime");

    const { data: row, error: readError } = await db
      .from("equipment_lead_times")
      .select("id, model, currentLeadTime, typicalLeadTime, description, notes")
      .eq("id", params.leadTimeId)
      .is("deletedAt", null)
      .maybeSingle();
    if (readError) throw new Error(`Could not load the lead time: ${readError.message}`);
    if (!row) throw notFound("That equipment is not on the lead-time list");

    const now = new Date().toISOString();
    const updates: Record<string, unknown> = { updatedAt: now, updatedById: tenantUser.id };
    for (const field of ["currentLeadTime", "typicalLeadTime", "description", "notes"] as const) {
      if (body[field] !== undefined) updates[field] = body[field];
    }

    const { data: updated, error } = await db
      .from("equipment_lead_times")
      .update(updates)
      .eq("id", row.id)
      .select(COLUMNS)
      .single();
    if (error) throw new Error(`Could not update ${row.model}: ${error.message}`);

    // History, but only for the number sales quotes — an edit to a note or a
    // description is not a change to what we are telling customers.
    const leadTimeChanged =
      body.currentLeadTime !== undefined && body.currentLeadTime !== row.currentLeadTime;
    if (leadTimeChanged) {
      // lint-conventions-allow: child-table-direct-query — the row this is
      // keyed to was loaded through the scoped client above, and tenantId is
      // stamped by it on insert.
      const { error: historyError } = await db.from("equipment_lead_time_changes").insert({
        id: newId(),
        leadTimeId: row.id,
        fromLeadTime: row.currentLeadTime,
        toLeadTime: body.currentLeadTime ?? null,
        note: body.notes ?? null,
        changedById: tenantUser.id,
        changedAt: now,
      });
      // Logged, not thrown: the lead time is already updated, and losing the
      // history entry must not read to the user as a failed save.
      if (historyError) {
        console.error(`[lead-times/${row.id}] history insert failed:`, historyError);
      }
    }

    // Sales asked to hear about this; engineering hears it too, and anyone
    // can turn the email off by type on their profile. Only the quoted number
    // is announced — a tidied note is not news (AUD: sales-visibility.md).
    if (leadTimeChanged) {
      const { data: people, error: peopleError } = await db
        .from("tenant_users")
        .select("id")
        .eq("isActive", true);
      if (peopleError) {
        console.error(`[lead-times/${row.id}] could not list recipients:`, peopleError);
      }

      const was = row.currentLeadTime ?? "not set";
      const now2 = updated.currentLeadTime ?? "not set";
      await sideEffect(
        notify({
          tenantId: tenantUser.tenantId,
          userIds: (people ?? []).map((person: { id: string }) => person.id),
          title: `${row.model}: ${now2}`,
          message:
            `${tenantUser.fullName ?? "Someone"} changed the ${row.model} lead time from ` +
            `${was} to ${now2}.` +
            (typeof body.notes === "string" && body.notes.trim() ? ` "${body.notes.trim()}"` : ""),
          type: "leadtime",
          link: "/lead-times",
          refId: row.id,
          actorId: tenantUser.id,
        }),
        `notify lead time change for ${row.model}`
      );
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "leadtime.update",
      entityType: "equipment_lead_time",
      entityId: row.id,
      details: {
        model: row.model,
        from: row.currentLeadTime ?? null,
        to: updated.currentLeadTime ?? null,
      },
    });

    return updated;
  }
);

export const GET = withTenant({ params: ParamsSchema }, async ({ db, params }) => {
  const { data: row } = await db
    .from("equipment_lead_times")
    .select("id, model")
    .eq("id", params.leadTimeId)
    .is("deletedAt", null)
    .maybeSingle();
  if (!row) throw notFound("That equipment is not on the lead-time list");

  // lint-conventions-allow: child-table-direct-query — keyed by a row loaded
  // through the scoped client just above.
  const { data: changes, error } = await db
    .from("equipment_lead_time_changes")
    .select(
      "id, fromLeadTime, toLeadTime, note, changedAt, " +
        "changedBy:tenant_users!equipment_lead_time_changes_changedById_fkey(fullName)"
    )
    .eq("leadTimeId", row.id)
    .order("changedAt", { ascending: false })
    .limit(50);
  if (error) throw new Error(`Could not load the history for ${row.model}: ${error.message}`);

  return { model: row.model, changes: changes ?? [] };
});
