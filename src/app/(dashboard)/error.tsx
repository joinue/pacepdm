"use client";

import { RouteError } from "@/components/ui/route-error";

/**
 * Catches throws from any dashboard segment that does not define its own
 * `error.tsx`. It sits inside the dashboard layout, so the sidebar and header
 * survive — the user keeps their navigation and can move on.
 */
export default function DashboardError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <RouteError error={error} retry={retry} />;
}
