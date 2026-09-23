import { withTenant, badRequest, forbidden, conflict, ApiFailure } from "@/lib/api-route";
import { permissionsExceedingActor, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { v4 as uuid } from "uuid";
import { z, nonEmptyString, ilikeExact } from "@/lib/validation";
import { sendInviteEmail } from "@/lib/email/send";
import { createAuthAdminClient, prepareInvitation, type PreparedInvitation } from "@/lib/invitations";

const InviteSchema = z.object({
  // Lowercased on the way in: Supabase Auth stores emails lowercased, and a
  // membership row holding another capitalisation is how one account came to
  // look like two (see the active-membership checks below).
  email: z.string().trim().toLowerCase().email("Must be a valid email"),
  fullName: nonEmptyString,
  roleId: nonEmptyString,
});

const ACTIVE_ELSEWHERE =
  "This user is active in another workspace. They must be deactivated there before they can join yours.";
const ALREADY_MEMBER = "User already exists in this workspace";

/**
 * The partial unique index from migration 054 allows one active membership
 * per auth account. It is the backstop for the checks in this route: two
 * invites racing, or a row whose email no longer matches the account's.
 */
function membershipConflict(error: { code?: string; message?: string }) {
  if (error.code !== "23505") return null;
  return conflict(
    error.message?.includes("tenant_users_one_active_per_auth_user")
      ? ACTIVE_ELSEWHERE
      : ALREADY_MEMBER
  );
}

/**
 * Invite someone to the workspace — or, if they were invited before and have
 * not accepted, send the invitation again.
 *
 * The membership row is written when the invitation is sent, with
 * `acceptedAt` null until the invitee sets a password on /accept-invite. A
 * second invitation to a pending address is therefore a resend, with the
 * name and role restated: it used to be refused as "already exists", which
 * sent admins to Remove → Invite to reissue a link their invitee's own email
 * had told them to ask for.
 *
 * An address with a confirmed account is added rather than invited: the
 * membership is stamped accepted, and the email says they can sign in with
 * the password they have (or set one through the link). That person used to
 * receive nothing.
 */
export const POST = withTenant(
  { permission: PERMISSIONS.ADMIN_USERS, body: InviteSchema },
  async ({ db, tenantUser, permissions, body, request }) => {
    const { email, fullName, roleId } = body;

    // Both lookups ignore case. They used `.eq("email")`, so inviting
    // `Bob@Acme.com` walked past Bob's `bob@acme.com` row while the auth
    // lookup below (which lowercases) still found his account — and inserted a
    // second active membership for it. findTenantUser's `.single()` then fails
    // on two rows, so Bob resolved to no workspace and was locked out of his
    // own. Any stranger could do it: sign-up is open, and every new workspace
    // makes its creator an Admin.
    const { data: existing, error: existingError } = await db
      .from("tenant_users")
      .select("id, authUserId, isActive, acceptedAt")
      .ilike("email", ilikeExact(email))
      .limit(1)
      .maybeSingle();
    if (existingError) throw existingError;

    if (existing && existing.acceptedAt !== null) throw conflict(ALREADY_MEMBER);
    if (existing && !existing.isActive) {
      throw conflict(
        "This person was invited and then deactivated. Reactivate them to send the invitation again."
      );
    }

    // A user can only be active in one workspace at a time. This is the early
    // check, before anything is sent; the authoritative one is by account id,
    // once the account is known, below.
    const crossTenant = db.unscoped(
      "one active membership per account is a rule across workspaces, checked by email here and by account id below"
    );
    const { data: activeElsewhere, error: elsewhereError } = await crossTenant
      .from("tenant_users")
      .select("id")
      .ilike("email", ilikeExact(email))
      .eq("isActive", true)
      .neq("tenantId", tenantUser.tenantId)
      .limit(1)
      .maybeSingle();
    if (elsewhereError) throw elsewhereError;
    if (activeElsewhere) throw conflict(ACTIVE_ELSEWHERE);

    const { data: role } = await db
      .from("roles")
      .select("id, permissions")
      .eq("id", roleId)
      .maybeSingle();
    if (!role) throw badRequest("Invalid role");

    // Privilege ceiling. Inviting someone into a role is assigning them one,
    // so it takes the same guard as changing an existing user's role in
    // users/[userId] — which had it while this route did not.
    //
    // The gap was reachable: ADMIN_USERS gates this route, and the seeded
    // Manager role holds ADMIN_USERS without holding "*". A Manager could
    // therefore invite an address they control as an Admin and come back
    // through the front door with permissions they were never granted.
    const newRolePerms = Array.isArray(role.permissions) ? (role.permissions as string[]) : [];
    const excess = permissionsExceedingActor(newRolePerms, permissions);
    if (excess.length > 0) {
      throw forbidden(
        `Cannot invite someone into a role with permissions you don't hold: ${excess.join(", ")}`
      );
    }

    const origin = new URL(request.url).origin;
    const prepared = await prepareInvitation(createAuthAdminClient(), {
      email,
      fullName,
      origin,
    });
    if (!prepared.ok) throw badRequest(prepared.message);
    const invitation = prepared.invitation;

    if (invitation.existingAccount) {
      // Check memberships by account, not by email. A membership row's email
      // is whatever was typed when it was created and can differ from the
      // account's; the account id cannot.
      const { data: memberships, error: membershipsError } = await crossTenant
        .from("tenant_users")
        .select("id, tenantId, isActive")
        .eq("authUserId", invitation.authUserId);
      if (membershipsError) throw membershipsError;

      const here = memberships?.find((m) => m.tenantId === tenantUser.tenantId);
      if (here && here.id !== existing?.id) throw conflict(ALREADY_MEMBER);
      if (memberships?.some((m) => m.isActive && m.tenantId !== tenantUser.tenantId)) {
        throw conflict(ACTIVE_ELSEWHERE);
      }
    }

    // "Added" is for an account that works today. A pending invitee whose
    // account is confirmed — they clicked Continue once and never set a
    // password — is still being invited, and gets the invitation wording.
    const addedExisting = invitation.existingAccount && !existing;

    const tenant = tenantUser.tenant as { name?: string; settings?: Record<string, unknown> };
    const replyTo = tenant?.settings?.emailReplyTo;
    await deliver(invitation, {
      to: email,
      recipientName: fullName,
      inviterName: tenantUser.fullName ?? "A teammate",
      tenantId: tenantUser.tenantId,
      tenantName: tenant?.name || "PACE PDM",
      existingAccount: addedExisting,
      replyTo: typeof replyTo === "string" && replyTo ? replyTo : undefined,
    });

    const now = new Date().toISOString();

    // Nothing was added to the workspace when the email did not go out, so the
    // admin can simply retry: the link is reissued for an invitee who has not
    // accepted yet.

    if (existing) {
      // A pending invitation, sent again. The admin has restated the name and
      // role, so the row takes them.
      const { data: updated, error: updateError } = await db
        .from("tenant_users")
        .update({ fullName, roleId, authUserId: invitation.authUserId, updatedAt: now })
        .eq("id", existing.id)
        .select()
        .single();
      if (updateError) throw updateError;

      await logAudit({
        tenantId: tenantUser.tenantId,
        userId: tenantUser.id,
        action: "user.invite_resend",
        entityType: "user",
        entityId: existing.id,
        details: { email, fullName, role: roleId },
      });

      return { user: updated, alreadyExisted: false, resent: true };
    }

    const { data: newUser, error: insertError } = await db
      .from("tenant_users")
      .insert({
        id: uuid(),
        authUserId: invitation.authUserId,
        email,
        fullName,
        roleId,
        isActive: true,
        // An existing account works today; the person was added, not
        // invited. A new account is pending until its password is set.
        acceptedAt: addedExisting ? now : null,
        createdAt: now,
        updatedAt: now,
      })
      .select()
      .single();

    if (insertError) {
      throw membershipConflict(insertError) ?? insertError;
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "user.invite",
      entityType: "user",
      entityId: newUser.id,
      details: { email, fullName, role: roleId, existingAccount: addedExisting },
    });

    return { user: newUser, alreadyExisted: addedExisting, resent: false };
  }
);

/**
 * Email the link. With app email configured the link is the one Supabase
 * issued to prepareInvitation; otherwise Supabase's mailer sends it, which for
 * a new account has already happened by now.
 */
async function deliver(
  invitation: PreparedInvitation,
  email: {
    to: string;
    recipientName: string;
    inviterName: string;
    tenantId: string;
    tenantName: string;
    existingAccount: boolean;
    replyTo?: string;
  }
) {
  if (invitation.link) {
    const sent = await sendInviteEmail({ ...email, link: invitation.link });
    if (!sent.ok) {
      throw new ApiFailure(`The invitation email could not be sent: ${sent.reason}`, 502);
    }
    return;
  }
  if (invitation.sendThroughSupabaseMailer) {
    const sent = await invitation.sendThroughSupabaseMailer();
    if (!sent.ok) {
      throw new ApiFailure(`The invitation email could not be sent: ${sent.message}`, 502);
    }
  }
}
