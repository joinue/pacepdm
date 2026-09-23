"use client";

import { Suspense, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/layout/logo";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import { safeNextPath } from "@/lib/safe-redirect";
import { fetchJson, errorMessage } from "@/lib/api-client";

// Derive the marketing site URL from the app URL. If NEXT_PUBLIC_APP_URL
// is https://app.pacepdm.com, the marketing site is https://pacepdm.com.
// Falls back to / for localhost where there's no subdomain.
const homepageUrl = (() => {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "";
  if (appUrl.includes("://app.")) return appUrl.replace("://app.", "://");
  return "/";
})();

/**
 * /auth/callback lands here with `?error=` when a code exchange fails. It
 * used to be ignored — the page has no reason to read the query string
 * otherwise — so someone whose confirmation link failed saw a bare sign-in
 * form with no idea why.
 */
function explainCallbackError(raw: string): string {
  if (raw === "missing_code" || /code verifier|auth code|pkce/i.test(raw)) {
    return "That link could not be completed in this browser. Sign in below — if your email is not confirmed yet, you will be offered a new link.";
  }
  if (/expired|invalid/i.test(raw)) {
    return "That link has expired or was already used. Sign in below, or request a new one.";
  }
  return raw;
}

function isEmailNotConfirmed(error: { code?: string; message: string }): boolean {
  return error.code === "email_not_confirmed" || /not confirmed/i.test(error.message);
}

function LoginForm() {
  const params = useSearchParams();
  const next = safeNextPath(params.get("next"));
  const callbackError = params.get("error");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(callbackError ? explainCallbackError(callbackError) : "");
  const [notice, setNotice] = useState("");
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [ssoLoading, setSsoLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setNotice("");
    setUnconfirmed(false);

    // SSO probe: if the email domain is registered for SSO in this
    // workspace, skip password auth and hand off to the IdP. Users who
    // don't know their workspace has SSO still land in the right place.
    try {
      const probe = await fetch("/api/auth/sso/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (probe.ok) {
        const data = (await probe.json()) as { useSso: boolean; domain?: string };
        if (data.useSso && data.domain) {
          const { data: sso, error: ssoErr } = await supabase.auth.signInWithSSO({
            domain: data.domain,
          });
          if (ssoErr) {
            setError(ssoErr.message);
            setLoading(false);
            return;
          }
          if (sso?.url) {
            window.location.href = sso.url;
            return;
          }
        }
      }
    } catch (err) {
      console.error("[login] SSO probe failed", err);
      // Fall through to password flow — SSO is best-effort, not a hard gate.
    }

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      if (isEmailNotConfirmed(error)) {
        setError("Your email address has not been confirmed yet.");
        setUnconfirmed(true);
      } else {
        setError(error.message);
      }
      setLoading(false);
      return;
    }

    router.push(next);
    router.refresh();
  }

  async function handleResendConfirmation() {
    setResending(true);
    setError("");
    try {
      const result = await fetchJson<{ status: "sent" | "already-confirmed" }>(
        "/api/auth/resend-confirmation",
        { method: "POST", body: { email } }
      );
      if (result.status === "already-confirmed") {
        setNotice("Your email is already confirmed. Check your password, or reset it below.");
      } else {
        setNotice(`We sent a new confirmation link to ${email}. You can open it on any device.`);
      }
      setUnconfirmed(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setResending(false);
    }
  }

  async function handleSsoOnly() {
    if (!email) {
      setError("Enter your work email first");
      return;
    }
    setSsoLoading(true);
    setError("");
    try {
      const probe = await fetch("/api/auth/sso/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!probe.ok) throw new Error("Failed to check SSO for this email");
      const data = (await probe.json()) as { useSso: boolean; domain?: string };
      if (!data.useSso || !data.domain) {
        setError("Single sign-on is not enabled for this domain");
        setSsoLoading(false);
        return;
      }
      const { data: sso, error: ssoErr } = await supabase.auth.signInWithSSO({
        domain: data.domain,
      });
      if (ssoErr) {
        setError(ssoErr.message);
        setSsoLoading(false);
        return;
      }
      if (sso?.url) {
        window.location.href = sso.url;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "SSO sign-in failed");
      setSsoLoading(false);
    }
  }

  return (
    <div className="min-h-dvh flex flex-col sm:items-center sm:justify-center bg-background">
      {/* Branding — takes up top space on mobile, sits above card on desktop */}
      <div className="flex-1 flex flex-col items-center justify-end pb-8 pt-16 sm:flex-none sm:pt-0 sm:pb-8">
        <a href={homepageUrl} className="flex flex-col items-center">
          <Logo size={52} className="sm:size-11 mb-4 sm:mb-3" />
          <h1 className="text-2xl sm:text-xl font-semibold tracking-tight">PACE PDM</h1>
        </a>
        <p className="text-sm sm:text-xs text-muted-foreground mt-1">Sign in to your workspace</p>
      </div>

      {/* Form — full-width on mobile, card on desktop */}
      <div className="shrink-0 sm:w-full sm:max-w-sm">
        <form
          onSubmit={handleLogin}
          className="w-full px-6 sm:rounded-xl sm:border sm:border-border/50 sm:bg-card sm:p-6 sm:ring-1 sm:ring-foreground/5"
        >
          <div className="space-y-5 sm:space-y-4">
            {error && (
              <div
                role="alert"
                className="bg-destructive/10 text-destructive text-sm sm:text-xs p-3 sm:p-2.5 rounded-lg border border-destructive/20 space-y-2"
              >
                <p>{error}</p>
                {unconfirmed && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={handleResendConfirmation}
                    disabled={resending}
                  >
                    {resending ? "Sending…" : "Send a new confirmation link"}
                  </Button>
                )}
              </div>
            )}
            {notice && (
              <div
                role="status"
                className="bg-primary/10 text-foreground text-sm sm:text-xs p-3 sm:p-2.5 rounded-lg border border-primary/20"
              >
                {notice}
              </div>
            )}

            <div className="space-y-2 sm:space-y-1.5">
              <Label htmlFor="email" className="text-sm sm:text-xs">
                Email
              </Label>
              <Input
                id="email"
                type="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-12 sm:h-9 text-base sm:text-sm rounded-lg"
                required
                autoFocus
                autoComplete="email"
              />
            </div>

            <div className="space-y-2 sm:space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="password" className="text-sm sm:text-xs">
                  Password
                </Label>
                <Link
                  href="/forgot-password"
                  className="text-sm sm:text-xs text-muted-foreground hover:text-primary transition-colors"
                >
                  Forgot password?
                </Link>
              </div>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-12 sm:h-9 text-base sm:text-sm pr-11 sm:pr-9 rounded-lg"
                  required
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 sm:right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors p-1"
                  tabIndex={-1}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                  ) : (
                    <Eye className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                  )}
                </button>
              </div>
            </div>

            <Button
              type="submit"
              className="w-full h-12 sm:h-9 text-base sm:text-sm rounded-lg mt-2"
              disabled={loading || ssoLoading}
            >
              {loading ? "Signing in..." : "Sign In"}
            </Button>

            <div className="flex items-center gap-3 text-3xs uppercase tracking-widest text-muted-foreground/60">
              <span className="flex-1 h-px bg-border" />
              or
              <span className="flex-1 h-px bg-border" />
            </div>

            <Button
              type="button"
              variant="outline"
              className="w-full h-12 sm:h-9 text-base sm:text-sm rounded-lg"
              onClick={handleSsoOnly}
              disabled={loading || ssoLoading}
            >
              <KeyRound className="h-4 w-4 mr-2" />
              {ssoLoading ? "Redirecting…" : "Sign in with SSO"}
            </Button>
          </div>

          <div className="text-sm sm:text-xs text-muted-foreground text-center mt-6 sm:mt-4 space-y-2">
            <p>
              No account?{" "}
              <Link href="/register" className="text-primary hover:underline font-medium">
                Create workspace
              </Link>
            </p>
            {/* The only other thing on this page was "Create workspace", so an
                invitee whose link had expired created a workspace of their own. */}
            <p>
              Invited to a workspace? Use the link in your invitation email. If it has expired,
              the person who invited you can resend it.
            </p>
          </div>
        </form>
      </div>

      {/* Bottom spacer — breathing room on mobile, small on desktop */}
      <div className="h-10 sm:h-8 shrink-0" />
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
