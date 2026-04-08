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

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <div className="min-h-dvh flex flex-col bg-background">
      {/* Branding area — pushes form down on mobile, centered on desktop */}
      <div className="flex-1 flex flex-col items-center justify-end pb-8 pt-16 sm:pt-8 sm:justify-center sm:pb-6">
        <Logo size={52} className="mb-4" />
        <h1 className="text-2xl sm:text-xl font-semibold tracking-tight">PACE PDM</h1>
        <p className="text-sm sm:text-xs text-muted-foreground mt-1">Sign in to your workspace</p>
      </div>

      {/* Form area — full width on mobile, constrained card on desktop */}
      <div className="flex-1 flex flex-col sm:flex-none sm:flex sm:items-center sm:justify-start sm:pb-16">
        <form
          onSubmit={handleLogin}
          className="w-full px-6 sm:px-0 sm:w-full sm:max-w-sm sm:rounded-xl sm:border sm:border-border/50 sm:bg-card sm:p-6 sm:ring-1 sm:ring-foreground/5"
        >
          <div className="space-y-5">
            {error && (
              <div className="bg-destructive/10 text-destructive text-sm p-3 rounded-lg border border-destructive/20">
                {error}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="email" className="text-sm sm:text-xs">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-12 sm:h-10 text-base sm:text-sm rounded-lg"
                required
                autoFocus
                autoComplete="email"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password" className="text-sm sm:text-xs">Password</Label>
                <Link href="/forgot-password" className="text-sm sm:text-xs text-muted-foreground hover:text-primary transition-colors">
                  Forgot password?
                </Link>
              </div>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-12 sm:h-10 text-base sm:text-sm pr-11 sm:pr-10 rounded-lg"
                  required
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors p-1"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="h-4 w-4 sm:h-3.5 sm:w-3.5" /> : <Eye className="h-4 w-4 sm:h-3.5 sm:w-3.5" />}
                </button>
              </div>
            </div>

            <Button type="submit" className="w-full h-12 sm:h-10 text-base sm:text-sm rounded-lg mt-2" disabled={loading}>
              {loading ? "Signing in..." : "Sign In"}
            </Button>
          </div>

          <p className="text-sm sm:text-xs text-muted-foreground text-center mt-6">
            No account?{" "}
            <Link href="/register" className="text-primary hover:underline font-medium">
              Create workspace
            </Link>
          </p>
        </form>

        {/* Bottom safe area spacer for mobile */}
        <div className="h-8 sm:h-0 shrink-0" />
      </div>
    </div>
  );
}
