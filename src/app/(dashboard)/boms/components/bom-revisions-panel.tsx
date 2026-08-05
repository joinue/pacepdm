"use client";

// Revision history for a BOM — the lineage it belongs to, oldest first,
// with the ECO that governed each step.
//
// `previousRevisionId` / `supersededById` made this walkable from migration
// 046 and nothing walked it. It became load-bearing once `implement_eco`
// started setting `supersededById` itself: a superseded revision is filtered
// out of the BOM list, so without this it is reachable only by typing its id
// into the URL.
//
// Read path: GET /api/boms/[bomId]/revisions — returns the whole chain, so
// the same response serves "what came before" on a current revision and
// "what replaced this" on a superseded one.

import { useRouter } from "next/navigation";
import { useFetch } from "@/hooks/use-fetch";
import { errorMessage } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { FormattedDate } from "@/components/ui/formatted-date";
import { GitBranch, Loader2, ArrowRight } from "lucide-react";

interface RevisionRow {
  id: string;
  name: string;
  revision: string;
  status: string;
  createdAt: string;
  releasedAt: string | null;
  createdByName: string | null;
  supersededById: string | null;
  isCurrent: boolean;
  isRequested: boolean;
  eco: {
    id: string;
    ecoNumber: string;
    title: string;
    status: string;
    implementedAt: string | null;
  } | null;
}

export function BomRevisionsPanel({ bomId }: { bomId: string }) {
  const router = useRouter();
  const { data, loading, error } = useFetch<RevisionRow[]>(`/api/boms/${bomId}/revisions`);
  const revisions = data ?? [];

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading revision history…
      </div>
    );
  }

  if (error) {
    return <p className="py-4 text-sm text-destructive">{errorMessage(error)}</p>;
  }

  // A BOM that has never been revised is a chain of one. Saying so beats an
  // empty panel that reads as a loading failure.
  if (revisions.length <= 1) {
    return (
      <p className="py-3 text-xs text-muted-foreground">
        No earlier revisions — this is the first.
      </p>
    );
  }

  return (
    <ol className="space-y-1.5">
      {revisions.map((rev) => {
        const isViewing = rev.isRequested;
        return (
          <li key={rev.id}>
            <Card
              className={
                isViewing ? "border-foreground/25 bg-muted/40" : "hover:border-foreground/20"
              }
            >
              <CardContent className="flex items-center gap-3 p-3">
                <div className="flex w-14 shrink-0 items-center gap-1.5">
                  <GitBranch className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
                  <span className="font-mono text-sm font-medium">{rev.revision}</span>
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge status={rev.status} kind="bom" className="text-4xs" />
                    {rev.isCurrent && (
                      <Badge variant="secondary" className="text-4xs">
                        Current
                      </Badge>
                    )}
                    {isViewing && <span className="text-4xs text-muted-foreground">viewing</span>}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    {rev.releasedAt ? (
                      <>
                        Released <FormattedDate date={rev.releasedAt} />
                      </>
                    ) : (
                      <>
                        Started <FormattedDate date={rev.createdAt} />
                      </>
                    )}
                    {rev.createdByName && <span>· {rev.createdByName}</span>}
                  </div>
                  {rev.eco ? (
                    <button
                      type="button"
                      onClick={() => router.push(`/ecos?ecoId=${rev.eco!.id}`)}
                      className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    >
                      <span className="font-mono">{rev.eco.ecoNumber}</span>
                      <span className="truncate">{rev.eco.title}</span>
                    </button>
                  ) : (
                    // Common and not a gap: a first release has no change
                    // order behind it, and `revise` takes an optional ecoId.
                    <p className="mt-1 text-xs text-muted-foreground/70">No change order</p>
                  )}
                </div>

                {!isViewing && (
                  <button
                    type="button"
                    onClick={() => router.push(`/boms/${rev.id}`)}
                    className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={`Open revision ${rev.revision}`}
                    title={`Open revision ${rev.revision}`}
                  >
                    <ArrowRight className="w-4 h-4" />
                  </button>
                )}
              </CardContent>
            </Card>
          </li>
        );
      })}
    </ol>
  );
}
