import { withTenant, notFound, conflict } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { notify, sideEffect } from "@/lib/notifications";
import { selectAll, selectAllIn } from "@/lib/paged-query";
import type { ScopedDb } from "@/lib/tenant-db";
import { z, optionalString, uuid } from "@/lib/validation";

/**
 * "Is this lead time still right?" — asked in the app instead of by email.
 *
 * Sales can read the lead-time page and not change it, so without this the
 * only way to chase a stale number is to message engineering, which is the
 * habit the page exists to replace. Flagging marks the machine and notifies
 * everyone who can answer; setting the lead time clears the flag (see the PUT
 * in ../route.ts), so nobody has to remember to tidy up.
 */

const ParamsSchema = z.object({ leadTimeId: uuid });
const FlagSchema = z.object({ reason: optionalString });

const FLAG_COLUMNS =
  "id, model, description, typicalLeadTime, currentLeadTime, notes, updatedAt, " +
  "flaggedAt, flagReason, " +
  "updatedBy:tenant_users!equipment_lead_times_updatedById_fkey(fullName), " +
  "flaggedBy:tenant_users!equipment_lead_times_flaggedById_fkey(fullName)";

/**
 * Everyone who can answer: holders of `leadtime.edit`, plus admins, who hold
 * it through `*`. Read from the roles themselves rather than by role name —
 * this workspace has custom roles, and a name proves nothing
 * (docs/decisions/system-roles.md).
 */
async function peopleWhoCanAnswer(db: ScopedDb): Promise<string[]> {
  const roles = await selectAll<{ id: string; permissions: unknown }>((from, to) =>
    db.from("roles").select("id, permissions").order("id").range(from, to)
  );

  const answering = roles
    .filter((role) => {
      const held = Array.isArray(role.permissions) ? (role.permissions as string[]) : [];
      return held.includes("*") || held.includes(PERMISSIONS.LEAD_TIME_EDIT);
    })
    .map((role) => role.id);
  if (answering.length === 0) return [];

  const people = await selectAllIn<{ id: string }>(answering, (chunk, from, to) =>
    db
      .from("tenant_users")
      .select("id")
      .eq("isActive", true)
      .in("roleId", chunk)
      .order("id")
      .range(from, to)
  );
  return people.map((person) => person.id);
}

export const POST = withTenant(
  { permission: PERMISSIONS.LEAD_TIME_FLAG, body: FlagSchema, params: ParamsSchema },
  async ({ db, tenantUser, params, body }) => {
    const { data: row } = await db
      .from("equipment_lead_times")
      .select("id, model, currentLeadTime, flaggedAt")
      .eq("id", params.leadTimeId)
      .is("deletedAt", null)
      .maybeSingle();
    if (!row) throw notFound("That equipment is not on the lead-time list");
    if (row.flaggedAt) {
      throw conflict(`${row.model} is already flagged — whoever can answer has been told.`);
    }

    const reason = body.reason?.trim() || null;
    const { data: updated, error } = await db
      .from("equipment_lead_times")
      .update({
        flaggedAt: new Date().toISOString(),
        flaggedById: tenantUser.id,
        flagReason: reason,
      })
      .eq("id", row.id)
      .select(FLAG_COLUMNS)
      .single();
    if (error) throw new Error(`Could not flag ${row.model}: ${error.message}`);

    const recipients = await peopleWhoCanAnswer(db);
    await sideEffect(
      notify({
        tenantId: tenantUser.tenantId,
        userIds: recipients,
        title: `${row.model}: lead time check`,
        message:
          `${tenantUser.fullName ?? "Someone"} asked for the ${row.model} lead time to be ` +
          `confirmed (currently ${row.currentLeadTime ?? "not set"}).` +
          (reason ? ` "${reason}"` : ""),
        type: "leadtime",
        link: "/lead-times",
        refId: row.id,
        actorId: tenantUser.id,
      }),
      `notify lead time flag for ${row.model}`
    );

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "leadtime.flag",
      entityType: "equipment_lead_time",
      entityId: row.id,
      details: { model: row.model, reason, askedOf: recipients.length },
    });

    return updated;
  }
);

/**
 * Drop the flag without changing the lead time — "checked, still six weeks".
 * For the people who answer flags, not the people who raise them.
 */
export const DELETE = withTenant(
  { permission: PERMISSIONS.LEAD_TIME_EDIT, params: ParamsSchema },
  async ({ db, tenantUser, params }) => {
    const { data: row } = await db
      .from("equipment_lead_times")
      .select("id, model, flaggedAt")
      .eq("id", params.leadTimeId)
      .is("deletedAt", null)
      .maybeSingle();
    if (!row) throw notFound("That equipment is not on the lead-time list");

    const { data: updated, error } = await db
      .from("equipment_lead_times")
      .update({ flaggedAt: null, flaggedById: null, flagReason: null })
      .eq("id", row.id)
      .select(FLAG_COLUMNS)
      .single();
    if (error) throw new Error(`Could not clear the flag on ${row.model}: ${error.message}`);

    if (row.flaggedAt) {
      await logAudit({
        tenantId: tenantUser.tenantId,
        userId: tenantUser.id,
        action: "leadtime.flag_cleared",
        entityType: "equipment_lead_time",
        entityId: row.id,
        details: { model: row.model },
      });
    }

    return updated;
  }
);
