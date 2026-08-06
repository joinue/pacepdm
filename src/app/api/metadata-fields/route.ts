import { withTenant, badRequest, conflict, notFound } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { v4 as uuid } from "uuid";
import { logAudit } from "@/lib/audit";
import { z, nonEmptyString } from "@/lib/validation";

const CreateFieldSchema = z.object({
  name: nonEmptyString,
  fieldType: z.enum(["TEXT", "NUMBER", "DATE", "BOOLEAN", "SELECT", "URL"]).optional(),
  options: z.array(z.string()).nullable().optional(),
  isRequired: z.boolean().optional(),
});

const DeleteFieldSchema = z.object({ fieldId: nonEmptyString });

export const POST = withTenant(
  { permission: PERMISSIONS.ADMIN_METADATA, body: CreateFieldSchema },
  async ({ db, tenantUser, body }) => {
    const now = new Date().toISOString();
    const fieldType = body.fieldType || "TEXT";

    // Get next sort order
    const { data: existing } = await db
      .from("metadata_fields")
      .select("sortOrder")
      .order("sortOrder", { ascending: false })
      .limit(1);

    const nextSort = existing && existing.length > 0 ? existing[0].sortOrder + 1 : 0;

    const { data: field, error } = await db
      .from("metadata_fields")
      .insert({
        id: uuid(),
        name: body.name,
        fieldType,
        options: body.options ?? null,
        isRequired: body.isRequired || false,
        isSystem: false,
        sortOrder: nextSort,
        appliesTo: [],
        createdAt: now,
        updatedAt: now,
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") throw conflict("A field with this name already exists");
      throw new Error(error.message);
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "metadata_field.create",
      entityType: "metadata_field",
      entityId: field.id,
      details: { name: body.name, fieldType },
    });

    return field;
  }
);

export const DELETE = withTenant(
  { permission: PERMISSIONS.ADMIN_METADATA, body: DeleteFieldSchema },
  async ({ db, tenantUser, body }) => {
    const { data: field } = await db
      .from("metadata_fields")
      .select("*")
      .eq("id", body.fieldId)
      .maybeSingle();

    if (!field) throw notFound("Field not found");
    if (field.isSystem) throw badRequest("Cannot delete system fields");

    // lint-conventions-allow: child-table-direct-query — parent resolved above through
    // the scoped client, which 404s on another tenant's fieldId before we reach here.
    //
    // Values first, because they are RESTRICT against the field. Both results
    // are checked: a discarded error here would report a deleted field that is
    // still on every form, and audit-log the deletion besides.
    const { error: valuesError } = await db
      .from("metadata_values")
      .delete()
      .eq("fieldId", body.fieldId);
    if (valuesError) throw conflict(`Could not delete field values: ${valuesError.message}`);

    const { error: fieldError } = await db.from("metadata_fields").delete().eq("id", body.fieldId);
    if (fieldError) throw conflict(`Could not delete field: ${fieldError.message}`);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "metadata_field.delete",
      entityType: "metadata_field",
      entityId: body.fieldId,
      details: { name: field.name },
    });

    return { success: true };
  }
);
