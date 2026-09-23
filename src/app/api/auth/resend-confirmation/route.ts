import { withPublicRoute, badRequest, notFound, ApiFailure } from "@/lib/api-route";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { appEmailConfigured, sendSignupConfirmationEmail } from "@/lib/email/send";
import { confirmPageLink, createAuthAdminClient } from "@/lib/invitations";
import { z } from "@/lib/validation";

const Schema = z.object({
  email: z.string().trim().toLowerCase().email("Must be a valid email"),
});

const ONBOARDING_PATH = "/onboarding";

type ResendResult = { status: "sent" } | { status: "already-confirmed" };

/**
 * A new confirmation link for an account that never confirmed its email.
 *
 * Reached from the sign-in page when Supabase answers "Email not confirmed":
 * the person signed up, the link expired or was eaten by a link scanner, and
 * the only thing the app offered was the same error again.
 *
 * The link is a `recovery` token rather than a `signup` one, because issuing
 * a signup token takes a password and this route does not have it.
 * Verifying a recovery token confirms an unconfirmed account and signs it in,
 * and the page it lands on is onboarding — so from the person's side it is
 * the confirmation link they asked for.
 */
export const POST = withPublicRoute(
  { body: Schema },
  async ({ body, request }): Promise<ResendResult> => {
    const { email } = body;
    const origin = new URL(request.url).origin;

    if (appEmailConfigured()) {
      const admin = createAuthAdminClient();
      const generated = await admin.auth.admin.generateLink({ type: "recovery", email });
      if (generated.error) {
        // Supabase answers a recovery for an unknown address with a not-found.
        if (generated.error.status === 404 || /not found/i.test(generated.error.message)) {
          throw notFound("No account uses this email address. Create a workspace to get started.");
        }
        throw badRequest(generated.error.message);
      }
      if (generated.data.user?.email_confirmed_at) return { status: "already-confirmed" };

      const hashedToken = generated.data.properties?.hashed_token;
      if (!hashedToken) throw new Error("Supabase returned no confirmation token");

      const recipientName = String(generated.data.user?.user_metadata?.full_name ?? "there");
      const sent = await sendSignupConfirmationEmail({
        to: email,
        recipientName,
        link: confirmPageLink(origin, hashedToken, "recovery", ONBOARDING_PATH),
      });
      if (!sent.ok) {
        throw new ApiFailure(`The confirmation email could not be sent: ${sent.reason}`, 502);
      }
      return { status: "sent" };
    }

    // No app email provider: ask Supabase's mailer to resend its own
    // confirmation. Same-browser only, like the fallback in register.
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: `${origin}/auth/callback?next=${ONBOARDING_PATH}` },
    });
    if (error) throw badRequest(error.message);
    return { status: "sent" };
  }
);
