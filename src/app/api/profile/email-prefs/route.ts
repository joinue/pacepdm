import { withTenant } from "@/lib/api-route";
import { z } from "@/lib/validation";
import { DEFAULT_EMAIL_PREFS } from "@/lib/email/send";

const EmailPrefsSchema = z.object({
  approval: z.boolean(),
  transition: z.boolean(),
  checkout: z.boolean(),
  eco: z.boolean(),
  system: z.boolean(),
});

export const GET = withTenant({}, async ({ db, tenantUser }) => {
  const { data } = await db
    .from("tenant_users")
    .select("emailPrefs")
    .eq("id", tenantUser.id)
    .maybeSingle();

  const prefs = {
    ...DEFAULT_EMAIL_PREFS,
    ...((data?.emailPrefs as Partial<typeof DEFAULT_EMAIL_PREFS>) || {}),
  };
  return { prefs };
});

export const PATCH = withTenant({ body: EmailPrefsSchema }, async ({ db, tenantUser, body }) => {
  const { error } = await db
    .from("tenant_users")
    .update({ emailPrefs: body, updatedAt: new Date().toISOString() })
    .eq("id", tenantUser.id);

  if (error) throw new Error(error.message);
  return { success: true, prefs: body };
});
