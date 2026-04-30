"use client";

import { useState, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/layout/logo";

const homepageUrl = (() => {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "";
  if (appUrl.includes("://app.")) return appUrl.replace("://app.", "://");
  return "/";
})();

export default function OnboardingPage() {
  const [companyName, setCompanyName] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const autoCreated = useRef(false);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    async function loadUser() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }

      const meta = user.user_metadata || {};
      const name = meta.full_name || "";
      const company = meta.company_name || "";
      const userEmail = user.email || "";

      setEmail(userEmail);
      setFullName(name);
      setCompanyName(company);

      // Auto-create the tenant if we have all the info from registration.
      if (name && company && userEmail && !autoCreated.current) {
        autoCreated.current = true;
        const res = await fetch("/api/tenants", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            companyName: company,
            fullName: name,
          }),
        });

        if (res.ok) {
          router.push("/");
          router.refresh();
          return;
        }

        // Tenant may already exist (e.g. page refresh) — check if we can
        // just go to the dashboard.
        const body = await res.json().catch(() => null);
        const msg = body?.error || "";

        // If the user already has a tenant, just redirect.
        if (res.status === 409 || msg.includes("already exists")) {
          router.push("/");
          router.refresh();
          return;
        }

        // Otherwise fall through to the manual form with the error shown.
        setError(msg || "Failed to create workspace. Please try again.");
      }

      setCheckingAuth(false);
    }
    loadUser();
  }, [supabase, router]);

  async function handleCreateWorkspace(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/tenants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName,
          fullName,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to create workspace");
        setLoading(false);
        return;
      }

      router.push("/");
      router.refresh();
    } catch {
      setError("Failed to create workspace. Please try again.");
      setLoading(false);
    }
  }

  if (checkingAuth) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center bg-background">
        <Logo size={40} className="mb-4 animate-pulse" />
        <p className="text-sm text-muted-foreground">Setting up your workspace...</p>
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
              <div className="bg-destructive/10 text-destructive text-sm sm:text-xs p-3 sm:p-2.5 rounded-lg border border-destructive/20">
                {error}
              </div>
            )}

            <div className="space-y-2 sm:space-y-1.5">
              <Label htmlFor="companyName" className="text-sm sm:text-xs">Company Name</Label>
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
              <Label htmlFor="fullName" className="text-sm sm:text-xs">Full Name</Label>
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
              <Label htmlFor="email" className="text-sm sm:text-xs">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                className="h-12 sm:h-9 text-base sm:text-sm rounded-lg bg-muted"
                disabled
              />
            </div>

            <Button type="submit" className="w-full h-12 sm:h-9 text-base sm:text-sm rounded-lg mt-2" disabled={loading}>
              {loading ? "Creating..." : "Create Workspace"}
            </Button>
          </div>
        </form>
      </div>

      <div className="h-10 sm:h-8 shrink-0" />
    </div>
  );
}
