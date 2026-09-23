import { withTenant, notFound, conflict, ApiFailure } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { z, uuid } from "@/lib/validation";
import { sendInviteEmail } from "@/lib/email/send";
import { createAuthAdminClient, prepareInvitation } from "@/lib/invitations";

/**
 * Send a pending invitation again.
 *
 * Invitation links expire (Supabase's email OTP expiry — an hour by default),
 * and the invitation email tells the recipient to ask for a new one. Until
 * this route existed there was nothing to ask for: a second invite was
 * refused as "already exists", and the workaround was Remove → Invite.
 *
 * Only a membership that is still pending can be resent. Once the person has
 * set a password they sign in like anyone else, and "Forgot password?" is
 * the right tool.
 */
export const POST = withTenant(
  { permission: PERMISSIONS.ADMIN_USERS, params: z.object({ userId: uuid }) },
  async ({ db, tenantUser, params, request }) => {
    const { data: member, error } = await db
      .from("tenant_users")
      .select("id, email, fullName, isActive, acceptedAt")
      .eq("id", params.userId)
      .maybeSingle();
    if (error) throw error;
    if (!member) throw notFound("User not found");
    if (member.acceptedAt !== null) {
      throw conflict(
        "This person has already accepted their invitation. If they cannot sign in, they can use “Forgot password?” on the sign-in page."
      );
    }
    if (!member.isActive) {
      throw conflict("This person is deactivated. Reactivate them before resending the invitation.");
    }

    const origin = new URL(request.url).origin;
    const prepared = await prepareInvitation(createAuthAdminClient(), {
      email: member.email,
      fullName: member.fullName,
      origin,
    });
    if (!prepared.ok) throw new ApiFailure(prepared.message, 502);
    const invitation = prepared.invitation;

    const tenant = tenantUser.tenant as { name?: string; settings?: Record<string, unknown> };
    const replyTo = tenant?.settings?.emailReplyTo;

    if (invitation.link) {
      const sent = await sendInviteEmail({
        to: member.email,
        recipientName: member.fullName,
        inviterName: tenantUser.fullName ?? "A teammate",
        tenantId: tenantUser.tenantId,
        tenantName: tenant?.name || "PACE PDM",
        link: invitation.link,
        // Still an invitation, whatever state the account is in: they have
        // not set a password yet.
        existingAccount: false,
        replyTo: typeof replyTo === "string" && replyTo ? replyTo : undefined,
      });
      if (!sent.ok) {
        throw new ApiFailure(`The invitation email could not be sent: ${sent.reason}`, 502);
      }
    } else if (invitation.sendThroughSupabaseMailer) {
      const sent = await invitation.sendThroughSupabaseMailer();
      if (!sent.ok) {
        throw new ApiFailure(`The invitation email could not be sent: ${sent.message}`, 502);
      }
    }

    // The account behind the row can change between sends — an unconfirmed
    // account recreated, say — and the row must point at the one the link
    // signs in.
    const { error: updateError } = await db
      .from("tenant_users")
      .update({ authUserId: invitation.authUserId, updatedAt: new Date().toISOString() })
      .eq("id", member.id);
    if (updateError) throw updateError;

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "user.invite_resend",
      entityType: "user",
      entityId: member.id,
      details: { email: member.email, fullName: member.fullName },
    });

    return { ok: true };
  }
);
