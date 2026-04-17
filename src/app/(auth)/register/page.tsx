"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/layout/logo";
import { Eye, EyeOff } from "lucide-react";

const homepageUrl = "/marketing";

export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [fullName, setFullName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?next=/onboarding`,
        data: {
          full_name: fullName,
          company_name: companyName,
        },
      },
    });

    if (authError) {
      setError(authError.message);
      setLoading(false);
      return;
    }

    if (!authData.user) {
      setError("Registration failed. Please try again.");
      setLoading(false);
      return;
    }

    // Try to create tenant immediately (works if email confirmation is off)
    const res = await fetch("/api/tenants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyName,
        fullName,
        email,
        authUserId: authData.user.id,
      }),
    });

    if (res.ok) {
      router.push("/");
      router.refresh();
    } else {
      // Email confirmation required — user will create workspace after confirming
      router.push("/onboarding");
      router.refresh();
    }
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
                autoFocus
                autoComplete="organization"
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
                autoComplete="name"
              />
            </div>

            <div className="space-y-2 sm:space-y-1.5">
              <Label htmlFor="email" className="text-sm sm:text-xs">Email</Label>
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
              <Label htmlFor="password" className="text-sm sm:text-xs">Password</Label>
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
                  {showPassword ? <EyeOff className="h-4 w-4 sm:h-3.5 sm:w-3.5" /> : <Eye className="h-4 w-4 sm:h-3.5 sm:w-3.5" />}
                </button>
              </div>
            </div>

            <Button type="submit" className="w-full h-12 sm:h-9 text-base sm:text-sm rounded-lg mt-2" disabled={loading}>
              {loading ? "Creating..." : "Create Workspace"}
            </Button>
          </div>

          <p className="text-sm sm:text-xs text-muted-foreground text-center mt-6 sm:mt-4">
            Already have an account?{" "}
            <Link href="/login" className="text-primary hover:underline font-medium">
              Sign in
            </Link>
          </p>
        </form>
      </div>

      <div className="h-10 sm:h-8 shrink-0" />
    </div>
  );
}
