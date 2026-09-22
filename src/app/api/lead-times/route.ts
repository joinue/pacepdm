import { v4 as newId } from "uuid";
import { withTenant, badRequest, conflict } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { selectAll } from "@/lib/paged-query";
import { LEAD_TIME_OPTIONS, isLeadTime } from "@/lib/lead-times";
import { z, nonEmptyString, optionalString } from "@/lib/validation";

/**
 * Equipment lead times — the list sales quotes from.
 *
 * Reading needs no permission beyond a session: sales holds Viewer, and a
 * lead-time page nobody in sales can open is the spreadsheet again. Writing
 * needs LEAD_TIME_EDIT.
 */

const AddModelSchema = z.object({
  model: nonEmptyString,
  description: optionalString,
  typicalLeadTime: optionalString,
});

const COLUMNS =
  "id, model, description, typicalLeadTime, currentLeadTime, notes, updatedAt, " +
  "updatedBy:tenant_users!equipment_lead_times_updatedById_fkey(fullName)";

export const GET = withTenant({}, async ({ db }) => {
  // Every model in the workspace: 33 seeded, a handful added since. Paged
  // anyway, because a 1000-row PostgREST cap that bites silently is how a
  // page starts lying about what it shows.
  const rows = await selectAll((from, to) =>
    db
      .from("equipment_lead_times")
      .select(COLUMNS)
      .is("deletedAt", null)
      .order("model")
      .range(from, to)
  );

  return { leadTimes: rows, options: LEAD_TIME_OPTIONS };
});

export const POST = withTenant(
  { permission: PERMISSIONS.LEAD_TIME_EDIT, body: AddModelSchema },
  async ({ db, tenantUser, body }) => {
    const model = body.model.trim();
    if (body.typicalLeadTime && !isLeadTime(body.typicalLeadTime)) {
      throw badRequest(`"${body.typicalLeadTime}" is not one of the lead times sales quotes.`, {
        options: LEAD_TIME_OPTIONS,
      });
    }

    const { data: existing } = await db
      .from("equipment_lead_times")
      .select("id, model")
      .ilike("model", model)
      .is("deletedAt", null)
      .maybeSingle();
    if (existing) throw conflict(`${existing.model} is already on the lead-time list.`);

    const { data: row, error } = await db
      .from("equipment_lead_times")
      .insert({
        id: newId(),
        model,
        description: body.description ?? null,
        typicalLeadTime: body.typicalLeadTime ?? null,
        createdById: tenantUser.id,
        createdAt: new Date().toISOString(),
      })
      .select(COLUMNS)
      .single();
    if (error) {
      // The partial unique index catches a race the check above cannot.
      if (error.code === "23505") throw conflict(`${model} is already on the lead-time list.`);
      throw new Error(`Could not add ${model}: ${error.message}`);
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "leadtime.add",
      entityType: "equipment_lead_time",
      entityId: row.id,
      details: { model, typicalLeadTime: body.typicalLeadTime ?? null },
    });

    return row;
  }
);
