/**
 * Getting an invitation link to someone, whether or not they already have an
 * account.
 *
 * Used by POST /api/users/invite and POST /api/users/[userId]/resend-invite.
 * The two questions this answers for a route are "which auth account is this
 * for?" — needed before anything is written, because membership rules are
 * checked by account id — and "how do we get a link to them?", which depends
 * on the account's state:
 *
 *   no account, or an unconfirmed one   →  an `invite` link. Creates the
 *                                          account if needed; reissues the
 *                                          token for one that never accepted.
 *   a confirmed account                 →  a `recovery` link. The invitee may
 *                                          have a password (registered before,
 *                                          or a member elsewhere) or not
 *                                          (clicked Continue on an earlier
 *                                          invite and closed the tab). Either
 *                                          way, verifying it signs them in and
 *                                          lands them on /accept-invite to set
 *                                          one. Verifying a recovery token also
 *                                          confirms an unconfirmed account.
 *
 * Both links point at the app's /auth/confirm, which verifies the token hash
 * on a click; see src/app/auth/confirm/page.tsx for why not on load.
 *
 * The invitation used to be sent and the account looked up in one call, so
 * an existing account received nothing at all: the route added the
 * membership and told the admin "they already have an account". That person
 * was never told they had been added anywhere.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { appEmailConfigured } from "@/lib/email/send";

export const ACCEPT_INVITE_PATH = "/accept-invite";

/** Supabase Auth's admin API. Service role; never hand it to the client. */
export function createAuthAdminClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

export function isEmailExistsError(error: { code?: string; message: string }): boolean {
  const message = error.message.toLowerCase();
  return (
    error.code === "email_exists" ||
    message.includes("already been registered") ||
    message.includes("already registered") ||
    message.includes("already exists")
  );
}

/** A link to the app's confirm page carrying a token hash Supabase issued. */
export function confirmPageLink(
  origin: string,
  hashedToken: string,
  type: "invite" | "recovery" | "signup",
  next: string
): string {
  const link = new URL("/auth/confirm", origin);
  link.searchParams.set("token_hash", hashedToken);
  link.searchParams.set("type", type);
  link.searchParams.set("next", next);
  return link.toString();
}

const AUTH_USERS_PAGE_SIZE = 1000;

/**
 * Find an auth user by email across every page of the project's users.
 *
 * Only the Supabase-mailer fallback needs this now: generateLink returns the
 * account with the token. listUsers() with no arguments returns just the
 * first page — 50 users — so once the project (every tenant together)
 * outgrew that, an existing account was never found.
 */
export async function findAuthUserByEmail(admin: SupabaseClient, email: string) {
  const target = email.toLowerCase();
  // Stops on an empty page rather than a short one, so a server-side cap on
  // perPage cannot end the search early. The bound is only a backstop.
  for (let page = 1; page <= 1000; page++) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: AUTH_USERS_PAGE_SIZE,
    });
    if (error) throw error;
    if (data.users.length === 0) return null;
    const match = data.users.find((u) => u.email?.toLowerCase() === target);
    if (match) return match;
  }
  return null;
}

export interface PreparedInvitation {
  /** The account the link is for. Known before anything is written or sent. */
  authUserId: string;
  /**
   * The address already had a confirmed account. Such a member is added
   * rather than invited: their account works today, so the email says so and
   * the membership is stamped accepted at once.
   */
  existingAccount: boolean;
  /**
   * The link the email should carry, or null when Supabase's own mailer has
   * to send it (no app email provider configured).
   */
  link: string | null;
  /**
   * Send through Supabase's mailer. Only defined on the fallback path, and
   * only when the preparation itself did not already send (an `invite`
   * through inviteUserByEmail is created and sent in one call). Call it once
   * the membership checks have passed.
   */
  sendThroughSupabaseMailer?: () => Promise<{ ok: true } | { ok: false; message: string }>;
}

export type PrepareResult =
  | { ok: true; invitation: PreparedInvitation }
  | { ok: false; message: string };

interface PrepareParams {
  email: string;
  fullName: string;
  /** The app's origin, for the link. */
  origin: string;
}

/**
 * Work out which account an invitation to `email` is for, and get a link.
 *
 * With app email configured this sends nothing — the caller checks the
 * account's memberships and then emails the link. Without it, the invitation
 * goes through Supabase's mailer, which depends on the dashboard's templates
 * and cannot separate creating the account from emailing it.
 */
export async function prepareInvitation(
  admin: SupabaseClient,
  params: PrepareParams
): Promise<PrepareResult> {
  const { email, fullName, origin } = params;
  const next = ACCEPT_INVITE_PATH;

  if (appEmailConfigured()) {
    const invite = await admin.auth.admin.generateLink({
      type: "invite",
      email,
      options: { data: { full_name: fullName } },
    });
    if (!invite.error) {
      const hashedToken = invite.data.properties?.hashed_token;
      const authUserId = invite.data.user?.id;
      if (!hashedToken || !authUserId) {
        return { ok: false, message: "Supabase returned no invitation token" };
      }
      return {
        ok: true,
        invitation: {
          authUserId,
          existingAccount: false,
          link: confirmPageLink(origin, hashedToken, "invite", next),
        },
      };
    }
    if (!isEmailExistsError(invite.error)) {
      return { ok: false, message: invite.error.message };
    }

    // A confirmed account. generateLink refuses to invite it, and returns
    // the account with a recovery token instead — no listUsers scan needed.
    const recovery = await admin.auth.admin.generateLink({ type: "recovery", email });
    if (recovery.error) return { ok: false, message: recovery.error.message };
    const hashedToken = recovery.data.properties?.hashed_token;
    const authUserId = recovery.data.user?.id;
    if (!hashedToken || !authUserId) {
      return { ok: false, message: "Supabase returned no recovery token" };
    }
    return {
      ok: true,
      invitation: {
        authUserId,
        existingAccount: true,
        link: confirmPageLink(origin, hashedToken, "recovery", next),
      },
    };
  }

  console.warn(
    "[invite] RESEND_API_KEY/EMAIL_FROM not set; sending the invitation through Supabase's mailer, which depends on the dashboard templates"
  );

  const redirectTo = `${origin}/auth/confirm?next=${next}`;
  const invited = await admin.auth.admin.inviteUserByEmail(email, {
    data: { full_name: fullName },
    redirectTo,
  });
  if (!invited.error) {
    return {
      ok: true,
      invitation: { authUserId: invited.data.user.id, existingAccount: false, link: null },
    };
  }
  if (!isEmailExistsError(invited.error)) {
    return { ok: false, message: invited.error.message };
  }

  const existing = await findAuthUserByEmail(admin, email);
  if (!existing) return { ok: false, message: invited.error.message };

  return {
    ok: true,
    invitation: {
      authUserId: existing.id,
      existingAccount: true,
      link: null,
      async sendThroughSupabaseMailer() {
        // A plain client with the implicit flow, as /api/auth/forgot-password
        // uses: no PKCE verifier is stashed, so the link works on any device.
        const anon = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
          { auth: { autoRefreshToken: false, persistSession: false, flowType: "implicit" } }
        );
        const { error } = await anon.auth.resetPasswordForEmail(email, { redirectTo });
        return error ? { ok: false, message: error.message } : { ok: true };
      },
    },
  };
}
