"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/ui/page-container";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * The body of a route segment's `error.tsx`.
 *
 * Every dashboard segment needs one — without it a throw in a server component
 * escapes to Next's default error page, which in production is an unstyled
 * "Application error" with no shell, no navigation, and no way back. The user
 * cannot tell a failed BOM query from the app being down.
 *
 * `retry` (not `reset` — Next renamed it, stable as of 16.3) re-renders the
 * segment, which re-runs the server component's fetch. That genuinely recovers
 * from the common case here: a transient Supabase failure.
 *
 * The digest is shown because it is the only handle a user can quote back that
 * ties their report to a specific server-side stack trace.
 */
export function RouteError({
  error,
  retry,
  title = "Something went wrong",
  description,
}: {
  error: Error & { digest?: string };
  retry: () => void;
  title?: string;
  description?: string;
}) {
  useEffect(() => {
    console.error("[route error]", error);
  }, [error]);

  return (
    <PageContainer>
      <EmptyState
        icon={AlertTriangle}
        title={title}
        description={
          description ??
          error.message ??
          "This page could not be loaded. The problem is on our side, not yours."
        }
        action={
          <div className="flex flex-col items-center gap-2">
            <Button size="sm" onClick={retry}>
              Try again
            </Button>
            {error.digest && (
              <p className="text-3xs text-muted-foreground">
                Reference: <code>{error.digest}</code>
              </p>
            )}
          </div>
        }
      />
    </PageContainer>
  );
}
