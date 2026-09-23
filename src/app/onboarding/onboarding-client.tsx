"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/layout/logo";
import { fetchJson, errorMessage, ApiError } from "@/lib/api-client";

const homepageUrl = (() => {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "";
  if (appUrl.includes("://app.")) return appUrl.replace("://app.", "://");
  return "/";
})();

interface OnboardingClientProps {
  email: string;
  fullName: string;
  companyName: string;
  /**
   * Workspaces this person was a member of and is no longer active in. When
   * non-empty, the page explains that instead of offering a new workspace.
   */
  deactivatedFrom: string[];
}

export function OnboardingClient(props: OnboardingClientProps) {
  const [companyName, setCompanyName] = useState(props.companyName);
  const [fullName, setFullName] = useState(props.fullName);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const deactivated = props.deactivatedFrom.length > 0;
  // Registration collected everything the workspace needs, so it is created
  // without a second form. Only ever once per mount: React strict mode runs
  // effects twice, and the second POST would answer "already a member".
  const canAutoCreate = !deactivated && Boolean(props.fullName && props.companyName);
  const [creating, setCreating] = useState(canAutoCreate);
  const autoCreated = useRef(false);
  const router = useRouter();

  async function createWorkspace(body: { companyName: string; fullName: string }) {
    try {
      await fetchJson("/api/tenants", { method: "POST", body });
    } catch (err) {
      // Already a member (a refresh after a successful create, say): the
      // dashboard is the right place.
      if (err instanceof ApiError && err.status === 409) {
        router.push("/");
        router.refresh();
        return;
      }
      throw err;
    }
    router.push("/");
    router.refresh();
  }

  useEffect(() => {
    if (!canAutoCreate || autoCreated.current) return;
    autoCreated.current = true;
    createWorkspace({ companyName: props.companyName, fullName: props.fullName }).catch((err) => {
      // Fall through to the form with the reason shown.
      setError(errorMessage(err));
      setCreating(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount by design
  }, []);

  async function handleCreateWorkspace(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await createWorkspace({ companyName, fullName });
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  }

  if (creating) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center bg-background">
        <Logo size={40} className="mb-4 animate-pulse" />
        <p className="text-sm text-muted-foreground">Setting up your workspace...</p>
      </div>
    );
  }

  if (deactivated) {
    const names = props.deactivatedFrom.join(", ");
    return (
      <div className="min-h-dvh flex flex-col sm:items-center sm:justify-center bg-background">
        <div className="flex flex-col items-center pt-12 pb-6 sm:flex-none sm:pt-0 sm:pb-8">
          <a href={homepageUrl} className="flex flex-col items-center">
            <Logo size={52} className="sm:size-11 mb-4 sm:mb-3" />
            <h1 className="text-2xl sm:text-xl font-semibold tracking-tight">PACE PDM</h1>
          </a>
          <p className="text-sm sm:text-xs text-muted-foreground mt-1">Your access has changed</p>
        </div>

        <div className="shrink-0 sm:w-full sm:max-w-sm">
          <div className="w-full px-6 sm:rounded-xl sm:border sm:border-border/50 sm:bg-card sm:p-6 sm:ring-1 sm:ring-foreground/5 space-y-4">
            <p className="text-sm">
              Your account ({props.email}) is no longer active in {names}. An admin of that
              workspace can reactivate you, and nothing you worked on has been lost.
            </p>
            <p className="text-sm sm:text-xs text-muted-foreground">
              If you meant to start a separate workspace of your own, you can{" "}
              <Link href="/onboarding?create=1" className="text-primary hover:underline font-medium">
                create a new one
              </Link>
              .
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
        <p className="text-sm sm:text-xs text-muted-foreground mt-1">Set up your workspace</p>
      </div>

      <div className="shrink-0 sm:w-full sm:max-w-sm">
        <form
          onSubmit={handleCreateWorkspace}
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
              />
            </div>

            <div className="space-y-2 sm:space-y-1.5">
              <Label htmlFor="email" className="text-sm sm:text-xs">
                Email
              </Label>
              <Input
                id="email"
                type="email"
                value={props.email}
                className="h-12 sm:h-9 text-base sm:text-sm rounded-lg bg-muted"
                disabled
              />
            </div>

            <Button
              type="submit"
              className="w-full h-12 sm:h-9 text-base sm:text-sm rounded-lg mt-2"
              disabled={loading}
            >
              {loading ? "Creating..." : "Create Workspace"}
            </Button>
          </div>

          <p className="text-sm sm:text-xs text-muted-foreground text-center mt-6 sm:mt-4">
            Joining a team that already uses PACE PDM? Ask them to invite you instead of creating
            a workspace here.
          </p>
        </form>
      </div>

      <div className="h-10 sm:h-8 shrink-0" />
    </div>
  );
}
