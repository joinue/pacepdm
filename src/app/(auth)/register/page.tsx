"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/layout/logo";
import { Eye, EyeOff, Mail } from "lucide-react";
import { fetchJson, errorMessage } from "@/lib/api-client";

const homepageUrl = (() => {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "";
  if (appUrl.includes("://app.")) return appUrl.replace("://app.", "://");
  return "/";
})();

type RegisterResult = { status: "sent" } | { status: "exists" } | { status: "signed-in" };

export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [fullName, setFullName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [error, setError] = useState("");
  const [exists, setExists] = useState(false);
  const [loading, setLoading] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [resent, setResent] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  async function register(): Promise<RegisterResult> {
    return fetchJson<RegisterResult>("/api/auth/register", {
      method: "POST",
      body: { email, password, fullName, companyName },
    });
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setExists(false);

    // Through the server, which issues the token and sends the email itself.
    // supabase.auth.signUp from here produced a link that only worked in this
    // browser, and a "check your email" screen for addresses that already had
    // an account. See /api/auth/register.
    let result: RegisterResult;
    try {
      result = await register();
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
      return;
    }

    if (result.status === "exists") {
      setExists(true);
      setLoading(false);
      return;
    }

    if (result.status === "signed-in") {
      // Confirmations are off in this environment. The server may have set the
      // session cookies already; signing in here covers the case where it
      // only created the account. The dashboard layout redirects to
      // /onboarding until a tenant exists.
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setError(error.message);
        setLoading(false);
        return;
      }
      router.push("/onboarding");
      router.refresh();
      return;
    }

    setEmailSent(true);
    setLoading(false);
  }

  async function handleResend() {
    setLoading(true);
    setError("");
    try {
      // The route reissues the token for an account that has not confirmed
      // yet, so re-registering is the resend.
      const result = await register();
      if (result.status === "exists") {
        setError("This email is already confirmed. Sign in instead.");
      } else {
        setResent(true);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  if (emailSent) {
    return (
      <div className="min-h-dvh flex flex-col sm:items-center sm:justify-center bg-background">
        <div className="flex flex-col items-center pt-12 pb-6 sm:flex-none sm:pt-0 sm:pb-8">
          <a href={homepageUrl} className="flex flex-col items-center">
            <Logo size={52} className="sm:size-11 mb-4 sm:mb-3" />
            <h1 className="text-2xl sm:text-xl font-semibold tracking-tight">PACE PDM</h1>
          </a>
        </div>

        <div className="shrink-0 sm:w-full sm:max-w-sm">
          <div className="w-full px-6 sm:rounded-xl sm:border sm:border-border/50 sm:bg-card sm:p-6 sm:ring-1 sm:ring-foreground/5 text-center">
            <div className="flex justify-center mb-4">
              <div className="rounded-full bg-primary/10 p-3">
                <Mail className="h-6 w-6 text-primary" />
              </div>
            </div>
            <h2 className="text-lg sm:text-base font-semibold mb-2">Check your email</h2>
            <p className="text-sm sm:text-xs text-muted-foreground mb-1">
              We sent a confirmation link to
            </p>
            <p className="text-sm sm:text-xs font-medium mb-4">{email}</p>
            <p className="text-sm sm:text-xs text-muted-foreground">
              Click the link in the email to confirm your address and finish setting up your
              workspace. You can open it on any device.
            </p>
            {error && (
              <div
                role="alert"
                className="bg-destructive/10 text-destructive text-sm sm:text-xs p-3 sm:p-2.5 rounded-lg border border-destructive/20 mt-4 text-left"
              >
                {error}
              </div>
            )}
            <p className="text-sm sm:text-xs text-muted-foreground mt-6 sm:mt-4">
              {resent ? (
                "Sent again. Check your spam folder if it does not arrive."
              ) : (
                <>
                  Didn&apos;t get it?{" "}
                  <button
                    type="button"
                    onClick={handleResend}
                    disabled={loading}
                    className="text-primary hover:underline font-medium disabled:opacity-50"
                  >
                    {loading ? "Sending…" : "Send it again"}
                  </button>
                </>
              )}
            </p>
            <p className="text-sm sm:text-xs text-muted-foreground mt-2">
              Already confirmed?{" "}
              <Link href="/login" className="text-primary hover:underline font-medium">
                Sign in
              </Link>
            </p>
          </div>
        </div>

        <div className="h-10 sm:h-8 shrink-0" />
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex flex-col sm:items-center sm:justify-center bg-background">
      <div className="flex flex-col items-center pt-12 pb-6 sm:flex-none sm:pt-0 sm:pb-8">
        <a href={homepageUrl} className="flex flex-col items-center">
          <Logo size={52} className="sm:size-11 mb-4 sm:mb-3" />
          <h1 className="text-2xl sm:text-xl font-semibold tracking-tight">PACE PDM</h1>
        </a>
        <p className="text-sm sm:text-xs text-muted-foreground mt-1">Create your workspace</p>
      </div>

      <div className="shrink-0 sm:w-full sm:max-w-sm">
        <form
          onSubmit={handleRegister}
          className="w-full px-6 sm:rounded-xl sm:border sm:border-border/50 sm:bg-card sm:p-6 sm:ring-1 sm:ring-foreground/5"
        >
          <div className="space-y-5 sm:space-y-4">
            {error && (
              <div
                role="alert"
                className="bg-destructive/10 text-destructive text-sm sm:text-xs p-3 sm:p-2.5 rounded-lg border border-destructive/20"
              >
                {error}
              </div>
            )}
            {exists && (
              <div
                role="alert"
                className="bg-destructive/10 text-destructive text-sm sm:text-xs p-3 sm:p-2.5 rounded-lg border border-destructive/20 space-y-1"
              >
                <p className="font-medium">An account already uses {email}.</p>
                <p>
                  <Link href="/login" className="underline font-medium">
                    Sign in
                  </Link>{" "}
                  instead, or{" "}
                  <Link href="/forgot-password" className="underline font-medium">
                    reset your password
                  </Link>{" "}
                  if you don&apos;t remember it. If a teammate invited you, use the link in their
                  email.
                </p>
              </div>
            )}

            <div className="space-y-2 sm:space-y-1.5">
              <Label htmlFor="companyName" className="text-sm sm:text-xs">
                Company Name
              </Label>
              <Input
                id="companyName"
                placeholder="PACE Technologies"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                className="h-12 sm:h-9 text-base sm:text-sm rounded-lg"
                required
                autoFocus
                autoComplete="organization"
              />
            </div>

            <div className="space-y-2 sm:space-y-1.5">
              <Label htmlFor="fullName" className="text-sm sm:text-xs">
                Full Name
              </Label>
              <Input
                id="fullName"
                placeholder="John Smith"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="h-12 sm:h-9 text-base sm:text-sm rounded-lg"
                required
                autoComplete="name"
              />
            </div>

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
                autoComplete="email"
              />
            </div>

            <div className="space-y-2 sm:space-y-1.5">
              <Label htmlFor="password" className="text-sm sm:text-xs">
                Password
              </Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="Min. 6 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-12 sm:h-9 text-base sm:text-sm pr-11 sm:pr-9 rounded-lg"
                  minLength={6}
                  required
                  autoComplete="new-password"
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
              disabled={loading}
            >
              {loading ? "Creating..." : "Create Workspace"}
            </Button>
          </div>

          <div className="text-sm sm:text-xs text-muted-foreground text-center mt-6 sm:mt-4 space-y-2">
            <p>
              Already have an account?{" "}
              <Link href="/login" className="text-primary hover:underline font-medium">
                Sign in
              </Link>
            </p>
            <p>Joining a team that already uses PACE PDM? Ask them to invite you instead.</p>
          </div>
        </form>
      </div>

      <div className="h-10 sm:h-8 shrink-0" />
    </div>
  );
}
