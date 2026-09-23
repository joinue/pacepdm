import { withPublicRoute, unauthorized, badRequest } from "@/lib/api-route";
import { getSession } from "@/lib/auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "@/lib/validation";

const Schema = z.object({
  password: z.string().min(6, "Password must be at least 6 characters"),
});

/**
 * Set the signed-in user's password. Used by /accept-invite and
 * /reset-password, which reach it through a session that an emailed token
 * created moments ago.
 *
 * Setting a password is what accepts an invitation, whichever page it happens
 * on: an invitee who ends up on the reset page — their link expired and they
 * used "Forgot password?" — has accepted just the same, and must not be sent
 * back to /accept-invite to do it again. So the stamp lives here, not in the
 * accept page.
 *
 * Public because the caller may have no tenant yet (a sign-up resetting a
 * password before onboarding). The session is the authorisation, and the
 * membership rows touched are the caller's own, keyed by their auth id.
 */
export const POST = withPublicRoute({ body: Schema }, async ({ body, db }) => {
  const user = await getSession();
  if (!user) {
    throw unauthorized(
      "Your link has expired, or you are not signed in. Open the link from your email again."
    );
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.updateUser({ password: body.password });
  if (error) throw badRequest(error.message);

  const now = new Date().toISOString();
  const { data: accepted, error: stampError } = await db
    .from("tenant_users")
    .update({ acceptedAt: now, updatedAt: now })
    .eq("authUserId", user.id)
    .is("acceptedAt", null)
    .select("id, tenantId");
  if (stampError) throw stampError;

  for (const row of accepted ?? []) {
    await logAudit({
      tenantId: row.tenantId,
      userId: row.id,
      action: "user.invite_accepted",
      entityType: "user",
      entityId: row.id,
      details: {},
    });
  }

  return { ok: true, accepted: (accepted ?? []).length > 0 };
});
