"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/layout/logo";
import { Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const supabase = createClient();
  const router = useRouter();

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }

    setLoading(true);

    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    toast.success("Password updated successfully");
    router.push("/");
    router.refresh();
  }

  return (
    <div className="min-h-dvh flex flex-col sm:items-center sm:justify-center bg-background">
      <div className="flex-1 flex flex-col items-center justify-end pb-8 pt-16 sm:flex-none sm:pt-0 sm:pb-8">
        <Logo size={52} className="sm:size-11 mb-4 sm:mb-3" />
        <h1 className="text-2xl sm:text-xl font-semibold tracking-tight">Set New Password</h1>
        <p className="text-sm sm:text-xs text-muted-foreground mt-1">Enter your new password below</p>
      </div>

      <div className="shrink-0 sm:w-full sm:max-w-sm">
        <form
          onSubmit={handleReset}
          className="w-full px-6 sm:rounded-xl sm:border sm:border-border/50 sm:bg-card sm:p-6 sm:ring-1 sm:ring-foreground/5"
        >
          <div className="space-y-5 sm:space-y-4">
            {error && (
              <div className="bg-destructive/10 text-destructive text-sm sm:text-xs p-3 sm:p-2.5 rounded-lg border border-destructive/20">{error}</div>
            )}

            <div className="space-y-2 sm:space-y-1.5">
              <Label htmlFor="password" className="text-sm sm:text-xs">New Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Min. 6 characters"
                  className="h-12 sm:h-9 text-base sm:text-sm pr-11 sm:pr-9 rounded-lg"
                  minLength={6}
                  required
                  autoFocus
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

            <div className="space-y-2 sm:space-y-1.5">
              <Label htmlFor="confirm" className="text-sm sm:text-xs">Confirm Password</Label>
              <Input
                id="confirm"
                type={showPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="h-12 sm:h-9 text-base sm:text-sm rounded-lg"
                required
                autoComplete="new-password"
              />
            </div>

            <Button type="submit" className="w-full h-12 sm:h-9 text-base sm:text-sm rounded-lg mt-2" disabled={loading}>
              {loading ? "Updating..." : "Update Password"}
            </Button>
          </div>
        </form>
      </div>

      <div className="h-10 sm:h-8 shrink-0" />
    </div>
  );
}
