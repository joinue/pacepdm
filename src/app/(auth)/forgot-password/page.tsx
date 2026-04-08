"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Mail } from "lucide-react";
import { Logo } from "@/components/layout/logo";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const supabase = createClient();

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    setSent(true);
    setLoading(false);
  }

  return (
    <div className="min-h-dvh flex flex-col bg-background">
      <div className="flex-1 flex flex-col items-center justify-end pb-8 pt-16 sm:pt-8 sm:justify-center sm:pb-6">
        <Logo size={52} className="mb-4" />
        <h1 className="text-2xl sm:text-xl font-semibold tracking-tight">Reset Password</h1>
        <p className="text-sm sm:text-xs text-muted-foreground mt-1">
          {sent ? "Check your email" : "Enter your email to receive a reset link"}
        </p>
      </div>

      <div className="flex-1 flex flex-col sm:flex-none sm:flex sm:items-center sm:justify-start sm:pb-16">
        <div className="w-full px-6 sm:px-0 sm:w-full sm:max-w-sm sm:rounded-xl sm:border sm:border-border/50 sm:bg-card sm:p-6 sm:ring-1 sm:ring-foreground/5">
          {sent ? (
            <div className="text-center space-y-4">
              <div className="w-14 h-14 bg-primary/10 rounded-full flex items-center justify-center mx-auto">
                <Mail className="w-7 h-7 text-primary" />
              </div>
              <p className="text-sm text-muted-foreground">
                We sent a password reset link to <span className="font-medium text-foreground">{email}</span>.
                Check your inbox and follow the link to reset your password.
              </p>
            </div>
          ) : (
            <form onSubmit={handleReset}>
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

                <Button type="submit" className="w-full h-12 sm:h-10 text-base sm:text-sm rounded-lg mt-2" disabled={loading}>
                  {loading ? "Sending..." : "Send Reset Link"}
                </Button>
              </div>
            </form>
          )}

          <div className="flex justify-center mt-6">
            <Link href="/login" className="text-sm sm:text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 transition-colors">
              <ArrowLeft className="w-4 h-4 sm:w-3 sm:h-3" />
              Back to sign in
            </Link>
          </div>
        </div>

        <div className="h-8 sm:h-0 shrink-0" />
      </div>
    </div>
  );
}
