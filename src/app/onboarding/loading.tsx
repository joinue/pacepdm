import { Logo } from "@/components/layout/logo";

// The page reads the caller's memberships before it knows what to show; this
// is the same "setting up" state the client renders while it creates the
// workspace, so the two blend.
export default function OnboardingLoading() {
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center bg-background">
      <Logo size={40} className="mb-4 animate-pulse" />
      <p className="text-sm text-muted-foreground">One moment...</p>
    </div>
  );
}
