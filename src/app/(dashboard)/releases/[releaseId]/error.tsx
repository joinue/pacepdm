"use client";

import { RouteError } from "@/components/ui/route-error";

/**
 * The release detail page fetches in a server component, so a transient
 * Supabase failure throws here rather than rendering. Without this the
 * throw escapes to the dashboard-level boundary and the user loses the
 * release they were looking at with no way back to it.
 */
export default function ReleaseError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <RouteError error={error} retry={retry} title="Could not load this release" />;
}
