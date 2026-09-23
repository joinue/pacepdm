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
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/layout/logo";
import { safeNextPath } from "@/lib/safe-redirect";
import { fetchJson } from "@/lib/api-client";
import { CONFIRM_COPY, explainFailure, intentFor, type Failure } from "./confirm-intent";

function ConfirmInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const token_hash = params.get("token_hash");
  const type = params.get("type");
  const next = safeNextPath(params.get("next"));
  const intent = intentFor(next, type);
  const copy = CONFIRM_COPY[intent];

  async function handleConfirm() {
    if (!token_hash || !type) {
      setFailure({
        message: "This link is missing its verification token.",
        hint: "Open the link from your email again, or ask for a new one.",
      });
      return;
    }
    setLoading(true);
    setFailure(null);

    try {
      await fetchJson("/api/auth/verify-otp", { method: "POST", body: { token_hash, type } });
    } catch (err) {
      setFailure(explainFailure(err, intent));
      setLoading(false);
      return;
    }

    router.push(next);
    router.refresh();
  }

  return (
    <div className="min-h-dvh flex flex-col sm:items-center sm:justify-center bg-background">
      <div className="flex-1 flex flex-col items-center justify-end pb-8 pt-16 sm:flex-none sm:pt-0 sm:pb-8">
        <Logo size={52} className="sm:size-11 mb-4 sm:mb-3" />
        <h1 className="text-2xl sm:text-xl font-semibold tracking-tight">{copy.heading}</h1>
        <p className="text-sm sm:text-xs text-muted-foreground mt-1 text-center px-6 max-w-sm">
          {copy.body}
        </p>
      </div>

      <div className="shrink-0 sm:w-full sm:max-w-sm">
        <div className="w-full px-6 sm:rounded-xl sm:border sm:border-border/50 sm:bg-card sm:p-6 sm:ring-1 sm:ring-foreground/5">
          <div className="space-y-4">
            {failure && (
              <div
                role="alert"
                className="bg-destructive/10 text-destructive text-sm sm:text-xs p-3 sm:p-2.5 rounded-lg border border-destructive/20 space-y-1"
              >
                <p className="font-medium">{failure.message}</p>
                {failure.hint && <p>{failure.hint}</p>}
              </div>
            )}
            <Button
              onClick={handleConfirm}
              disabled={loading || !token_hash || !type}
              className="w-full h-12 sm:h-9 text-base sm:text-sm rounded-lg"
            >
              {loading ? "Verifying..." : copy.cta}
            </Button>
            {failure && (
              <p className="text-sm sm:text-xs text-muted-foreground text-center">
                {intent === "recovery" ? (
                  <Link href="/forgot-password" className="text-primary hover:underline font-medium">
                    Request a new reset link
                  </Link>
                ) : (
                  <Link href="/login" className="text-primary hover:underline font-medium">
                    Go to sign in
                  </Link>
                )}
              </p>
            )}
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
