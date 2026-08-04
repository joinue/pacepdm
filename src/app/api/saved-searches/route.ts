import { withTenant } from "@/lib/api-route";
import { v4 as uuid } from "uuid";
import { z, nonEmptyString } from "@/lib/validation";

const SaveSearchSchema = z.object({
  name: nonEmptyString,
  filters: z.unknown(),
  isShared: z.boolean().optional(),
});

const DeleteSearchSchema = z.object({ searchId: nonEmptyString });

export const GET = withTenant({}, async ({ db, tenantUser }) => {
  const { data } = await db
    .from("saved_searches")
    .select("*")
    .or(`userId.eq.${tenantUser.id},isShared.eq.true`)
    .order("name");

  return data || [];
});

export const POST = withTenant({ body: SaveSearchSchema }, async ({ db, tenantUser, body }) => {
  const now = new Date().toISOString();

  const { data, error } = await db
    .from("saved_searches")
    .insert({
      id: uuid(),
      userId: tenantUser.id,
      name: body.name,
      filters: body.filters,
      isShared: body.isShared || false,
      createdAt: now,
      updatedAt: now,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
});

export const DELETE = withTenant({ body: DeleteSearchSchema }, async ({ db, tenantUser, body }) => {
  // Scoped to the author as well as the tenant: a shared search is visible
  // to everyone in the tenant, but only its author may remove it.
  await db.from("saved_searches").delete().eq("id", body.searchId).eq("userId", tenantUser.id);
  return { success: true };
});
