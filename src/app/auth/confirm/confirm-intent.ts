import { ApiError, errorMessage } from "@/lib/api-client";

/**
 * What the person is here to do. Decided by where the link lands rather than
 * by the token type: a resent invitation to a confirmed account carries a
 * `recovery` token but is still an invitation, and a resent sign-up
 * confirmation is a `recovery` token that is still a confirmation.
 */
export type Intent = "invite" | "signup" | "recovery" | "other";

export function intentFor(next: string, type: string | null): Intent {
  if (next.startsWith("/accept-invite")) return "invite";
  if (next.startsWith("/onboarding")) return "signup";
  if (next.startsWith("/reset-password")) return "recovery";
  if (type === "invite") return "invite";
  if (type === "signup") return "signup";
  if (type === "recovery") return "recovery";
  return "other";
}

export const CONFIRM_COPY: Record<Intent, { heading: string; body: string; cta: string }> = {
  invite: {
    heading: "Accept your invitation",
    body: "Click the button below to continue and set your password.",
    cta: "Accept invitation",
  },
  signup: {
    heading: "Confirm your email",
    body: "Click the button below to confirm your email address and set up your workspace.",
    cta: "Confirm email",
  },
  recovery: {
    heading: "Reset your password",
    body: "Click the button below to continue to the password reset page.",
    cta: "Continue",
  },
  other: {
    heading: "Confirm your email",
    body: "Click the button below to finish confirming your email address.",
    cta: "Continue",
  },
};

export interface Failure {
  message: string;
  hint: string;
}

/**
 * Supabase's message for a used or expired token is accurate and useless:
 * it does not say what to do. What to do depends on what the link was for.
 */
export function explainFailure(err: unknown, intent: Intent): Failure {
  const message = errorMessage(err) || "Verification failed";
  const expired =
    err instanceof ApiError && /expired|invalid|not found|already/i.test(err.message);
  if (!expired) return { message, hint: "" };

  switch (intent) {
    case "invite":
      return {
        message: "This invitation link has expired or was already used.",
        hint: "Ask the person who invited you to resend it from their Users page. If you already set a password, sign in instead.",
      };
    case "signup":
      return {
        message: "This confirmation link has expired or was already used.",
        hint: "Sign in with the password you chose and you will be offered a new link. If your email is already confirmed, signing in just works.",
      };
    case "recovery":
      return {
        message: "This password reset link has expired or was already used.",
        hint: "Request a new one from the sign-in page.",
      };
    default:
      return { message: "This link has expired or was already used.", hint: "" };
  }
}
