"use client";

import { AlertTriangle, Loader2, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api-client";

/**
 * What stopped an ECO being submitted or implemented, one line per problem.
 *
 * Both routes refuse with a 409 whose message names the first four problems
 * and whose `details.blockers` holds all of them (lib/eco-release-check.ts).
 * A toast only has room for the message, so an ECO with a dozen files checked
 * out showed four and "and 8 more — see the details", with nowhere to see them.
 */
export function blockersFromError(err: unknown): string[] | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const blockers = (err.details as { blockers?: unknown } | undefined)?.blockers;
  if (!Array.isArray(blockers) || blockers.length === 0) return null;
  return blockers.filter((b): b is string => typeof b === "string");
}

export function EcoBlockersPanel({
  ecoNumber,
  action,
  blockers,
  retrying,
  onRetry,
  onDismiss,
}: {
  ecoNumber: string;
  action: "submitted" | "implemented";
  blockers: string[];
  retrying: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const count = blockers.length === 1 ? "One thing stops" : `${blockers.length} things stop`;

  return (
    <div
      role="alert"
      className="mb-5 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3"
    >
      <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1 space-y-2 text-sm">
        <p className="font-medium">
          {count} {ecoNumber} being {action}
        </p>
        <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
          {/* Two files can share a name in different folders, so not keyed by text. */}
          {blockers.map((blocker, i) => (
            <li key={i}>{blocker}</li>
          ))}
        </ul>
        <Button size="sm" variant="outline" disabled={retrying} onClick={onRetry}>
          {retrying ? (
            <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
          ) : (
            <RotateCw className="w-3.5 h-3.5 mr-1.5" />
          )}
          Try again
        </Button>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <X className="w-4 h-4" />
      </Button>
    </div>
  );
}
