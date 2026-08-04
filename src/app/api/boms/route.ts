import { withTenant } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { v4 as uuidv4 } from "uuid";
import { z, nonEmptyString } from "@/lib/validation";

const CreateBomSchema = z.object({
  name: nonEmptyString,
});

export const GET = withTenant({}, async ({ db }) => {
  const { data } = await db
    .from("boms")
    .select("*")
    .is("deletedAt", null)
    .order("createdAt", { ascending: false })
    .limit(500);
  return data || [];
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
