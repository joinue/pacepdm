import { withPublicRoute, badRequest, ApiFailure } from "@/lib/api-route";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { appEmailConfigured, sendSignupConfirmationEmail } from "@/lib/email/send";
import { confirmPageLink, createAuthAdminClient, isEmailExistsError } from "@/lib/invitations";
import { z, nonEmptyString } from "@/lib/validation";

const RegisterSchema = z.object({
  email: z.string().trim().toLowerCase().email("Must be a valid email"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  fullName: nonEmptyString,
  companyName: nonEmptyString,
});

const ONBOARDING_PATH = "/onboarding";

/**
 * What happened, and so what the sign-up page should show next.
 *
 *   sent        the confirmation email is on its way; show "check your email"
 *   exists      a confirmed account already uses this address; say so, with
 *               sign-in and reset links, instead of a "check your email"
 *               screen that no email ever follows
 *   signed-in   confirmations are off in this environment and the session
 *               cookies are already set; go straight to onboarding
 */
type RegisterResult = { status: "sent" } | { status: "exists" } | { status: "signed-in" };

/**
 * Create the account behind a new workspace and get its confirmation link to
 * the person.
 *
 * The page used to call supabase.auth.signUp from the browser, which had
 * three problems the invitation flow had already solved for itself:
 *
 *   - the link only completed in the browser that started the sign-up. The
 *     browser client uses PKCE, so the email carried a `?code=` that
 *     /auth/callback could exchange only with the verifier cookie from that
 *     browser. Opening the email on a phone failed, and the failure was a
 *     bare login page.
 *   - it went through Supabase's mailer to Supabase's /verify endpoint, which
 *     verifies on GET — and corporate link scanners GET every link in an
 *     email before the person sees it, consuming the one-use token.
 *   - an address that was already registered got a fake success (Supabase's
 *     enumeration guard) and a "check your email" screen. Nothing arrived.
 *
 * Now the app issues the token with generateLink and sends the email itself,
 * pointing at /auth/confirm, which verifies on a click and on any device. For
 * an account that exists but was never confirmed, generateLink reissues the
 * token, so "sign up again" is a working resend.
 *
 * Saying "already registered" is a deliberate choice over the enumeration
 * guard: this is a B2B tool with open sign-up, and the invite route already
 * distinguishes an existing account. The person who forgot they have one is
 * the common case, and the message gets them in.
 */
export const POST = withPublicRoute(
  { body: RegisterSchema },
  async ({ body, request }): Promise<RegisterResult> => {
    const { email, password, fullName, companyName } = body;
    const origin = new URL(request.url).origin;
    const data = { full_name: fullName, company_name: companyName };

    if (appEmailConfigured()) {
      const admin = createAuthAdminClient();
      const generated = await admin.auth.admin.generateLink({
        type: "signup",
        email,
        password,
        options: { data },
      });
      if (generated.error) {
        if (isEmailExistsError(generated.error)) return { status: "exists" };
        throw badRequest(generated.error.message);
      }

      // Confirmations are off in this environment (local, usually), so the
      // account is usable already and the page can sign in with the password
      // it just collected.
      if (generated.data.user?.email_confirmed_at) return { status: "signed-in" };

      const hashedToken = generated.data.properties?.hashed_token;
      if (!hashedToken) throw new Error("Supabase returned no confirmation token");

      const sent = await sendSignupConfirmationEmail({
        to: email,
        recipientName: fullName,
        link: confirmPageLink(origin, hashedToken, "signup", ONBOARDING_PATH),
      });
      if (!sent.ok) {
        throw new ApiFailure(`The confirmation email could not be sent: ${sent.reason}`, 502);
      }
      return { status: "sent" };
    }

    // No app email provider: Supabase's mailer sends the confirmation, from
    // the dashboard's template. This is the old path, with its same-browser
    // limitation, kept so a local environment without Resend keys still
    // works. The server client stores the PKCE verifier in the response
    // cookies, so /auth/callback can complete the exchange.
    console.warn(
      "[register] RESEND_API_KEY/EMAIL_FROM not set; sending the confirmation through Supabase's mailer, which only completes in this browser"
    );
    const supabase = await createServerSupabaseClient();
    const { data: signedUp, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${origin}/auth/callback?next=${ONBOARDING_PATH}`, data },
    });
    if (error) throw badRequest(error.message);
    // Supabase's enumeration guard: an existing confirmed address comes back
    // as a user with no identities and no session.
    if (signedUp.user && (signedUp.user.identities?.length ?? 0) === 0) return { status: "exists" };
    if (signedUp.session) return { status: "signed-in" };
    return { status: "sent" };
  }
);
