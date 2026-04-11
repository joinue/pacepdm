"use client";

// Click-to-continue confirmation page for email links (recovery, invite, magic
// link, etc.). Why not verify on the GET request? Because email providers and
// corporate security scanners (Gmail, Outlook Safe Links, Proofpoint,
// Mimecast) prefetch URLs in messages, and verifying on GET would consume the
// single-use token before the real user ever clicks — producing the notorious
// "Email link is invalid or has expired" error. Requiring a user click (POST)
// sidesteps every prefetcher.

import { useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/layout/logo";

function ConfirmInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const token_hash = params.get("token_hash");
  const type = params.get("type");
  const next = params.get("next") ?? "/";

  async function handleConfirm() {
    if (!token_hash || !type) {
      setError("Missing verification token.");
      return;
    }
    setLoading(true);
    setError("");

    const res = await fetch("/api/auth/verify-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token_hash, type }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Verification failed");
      setLoading(false);
      return;
    }

    router.push(next);
    router.refresh();
  }

  const heading = type === "recovery" ? "Reset your password" : "Confirm your email";
  const body =
    type === "recovery"
      ? "Click the button below to continue to the password reset page."
      : "Click the button below to finish confirming your email address.";

  return (
    <div className="min-h-dvh flex flex-col sm:items-center sm:justify-center bg-background">
      <div className="flex-1 flex flex-col items-center justify-end pb-8 pt-16 sm:flex-none sm:pt-0 sm:pb-8">
        <Logo size={52} className="sm:size-11 mb-4 sm:mb-3" />
        <h1 className="text-2xl sm:text-xl font-semibold tracking-tight">{heading}</h1>
        <p className="text-sm sm:text-xs text-muted-foreground mt-1 text-center px-6 max-w-sm">{body}</p>
      </div>

      <div className="shrink-0 sm:w-full sm:max-w-sm">
        <div className="w-full px-6 sm:rounded-xl sm:border sm:border-border/50 sm:bg-card sm:p-6 sm:ring-1 sm:ring-foreground/5">
          <div className="space-y-4">
            {error && (
              <div className="bg-destructive/10 text-destructive text-sm sm:text-xs p-3 sm:p-2.5 rounded-lg border border-destructive/20">
                {error}
              </div>
            )}
            <Button
              onClick={handleConfirm}
              disabled={loading || !token_hash || !type}
              className="w-full h-12 sm:h-9 text-base sm:text-sm rounded-lg"
            >
              {loading ? "Verifying..." : "Continue"}
            </Button>
          </div>
        </div>
      </div>

      <div className="h-10 sm:h-8 shrink-0" />
    </div>
  );
}

export default function ConfirmPage() {
  return (
    <Suspense>
      <ConfirmInner />
    </Suspense>
  );
}
