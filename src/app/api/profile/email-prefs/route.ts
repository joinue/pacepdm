import { withTenant } from "@/lib/api-route";
import { z } from "@/lib/validation";
import { DEFAULT_EMAIL_PREFS, NOTIFICATION_TYPES, type EmailPrefs } from "@/lib/notification-types";

// One optional boolean per notification type, from the same list the sender
// reads. The schema used to name the types by hand, and Zod strips keys it
// does not know: "leadtime" was ticked off on the profile, saved with a
// success toast, dropped here, and the emails kept coming.
const EmailPrefsSchema = z.object(
  Object.fromEntries(NOTIFICATION_TYPES.map((t) => [t, z.boolean().optional()])) as Record<
    (typeof NOTIFICATION_TYPES)[number],
    z.ZodOptional<z.ZodBoolean>
  >
);

function withDefaults(stored: unknown): EmailPrefs {
  return { ...DEFAULT_EMAIL_PREFS, ...((stored as Partial<EmailPrefs> | null) ?? {}) };
}

export const GET = withTenant({}, async ({ db, tenantUser }) => {
  const { data } = await db
    .from("tenant_users")
    .select("emailPrefs")
    .eq("id", tenantUser.id)
    .maybeSingle();

  return { prefs: withDefaults(data?.emailPrefs) };
});

export const PATCH = withTenant({ body: EmailPrefsSchema }, async ({ db, tenantUser, body }) => {
  // Merged over what is stored, so a client that does not know a newer type
  // leaves that preference alone rather than resetting it.
  const { data: current } = await db
    .from("tenant_users")
    .select("emailPrefs")
    .eq("id", tenantUser.id)
    .maybeSingle();
  const patch = Object.fromEntries(
    Object.entries(body).filter(([, value]) => typeof value === "boolean")
  );
  const prefs: EmailPrefs = { ...withDefaults(current?.emailPrefs), ...patch };

  const { error } = await db
    .from("tenant_users")
    .update({ emailPrefs: prefs, updatedAt: new Date().toISOString() })
    .eq("id", tenantUser.id);

  if (error) throw new Error(error.message);
  return { success: true, prefs };
});
