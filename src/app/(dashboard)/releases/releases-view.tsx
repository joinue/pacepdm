"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Search, Package, FileText, Layers, Download, Rocket } from "lucide-react";
import { useFetch } from "@/hooks/use-fetch";
import { errorMessage } from "@/lib/api-client";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { FormattedDate } from "@/components/ui/formatted-date";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { ListRowsSkeleton } from "@/components/ui/page-skeleton";

interface ReleaseListRow {
  id: string;
  name: string;
  ecoId: string;
  ecoNumber: string;
  releasedAt: string;
  note: string | null;
  releasedBy: { fullName: string | null } | null;
  partCount: number;
  fileCount: number;
  bomCount: number;
}

/** "3 parts · 12 files · 1 BOM", skipping whatever is zero. */
function contentsSummary(row: ReleaseListRow): string {
  const bits: string[] = [];
  if (row.partCount) bits.push(`${row.partCount} part${row.partCount === 1 ? "" : "s"}`);
  if (row.fileCount) bits.push(`${row.fileCount} file${row.fileCount === 1 ? "" : "s"}`);
  if (row.bomCount) bits.push(`${row.bomCount} BOM${row.bomCount === 1 ? "" : "s"}`);
  return bits.length ? bits.join(" · ") : "Empty release";
}

export function ReleasesView() {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");

  // Local debounce feeding the fetch URL — same shape as the vendors and
  // parts pages. `useFetch` aborts the superseded request, so a slow early
  // search can't land on top of a fast later one.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(id);
  }, [search]);

  const url = useMemo(() => {
    const params = new URLSearchParams();
    if (debounced.trim()) params.set("q", debounced.trim());
    const qs = params.toString();
    return `/api/releases${qs ? `?${qs}` : ""}`;
  }, [debounced]);

  const { data, loading, error } = useFetch<ReleaseListRow[]>(url);
  const releases = data ?? [];

  return (
    <PageContainer>
      <PageHeader
        title="Releases"
        description="Every implemented change order, frozen as the package that shipped with it."
        actions={
          <div className="relative w-full sm:w-64">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search releases or ECO number"
              aria-label="Search releases"
              className="pl-8"
            />
          </div>
        }
      />

      {error ? (
        <Card>
          <CardContent className="p-6 text-sm text-destructive">{errorMessage(error)}</CardContent>
        </Card>
      ) : loading ? (
        <ListRowsSkeleton rows={6} />
      ) : releases.length === 0 ? (
        <EmptyState
          icon={Rocket}
          title={debounced.trim() ? "No matching releases" : "No releases yet"}
          description={
            debounced.trim()
              ? "No release name or ECO number matches that search."
              : "A release is captured automatically when an approved ECO is implemented."
          }
        />
      ) : (
        <ul className="divide-y rounded-lg border">
          {releases.map((release) => (
            <li key={release.id}>
              <div className="flex items-center gap-4 px-4 py-3 hover:bg-muted/50">
                <Link href={`/releases/${release.id}`} className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{release.name}</span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                      {release.ecoNumber}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                    <FormattedDate date={release.releasedAt} variant="datetime" />
                    {release.releasedBy?.fullName ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{release.releasedBy.fullName}</span>
                      </>
                    ) : null}
                    <span aria-hidden="true">·</span>
                    <span>{contentsSummary(release)}</span>
                  </div>
                </Link>

                <div
                  className="hidden shrink-0 items-center gap-3 text-xs text-muted-foreground sm:flex"
                  aria-hidden="true"
                >
                  {release.partCount > 0 && (
                    <span className="flex items-center gap-1">
                      <Package className="size-3.5" /> {release.partCount}
                    </span>
                  )}
                  {release.fileCount > 0 && (
                    <span className="flex items-center gap-1">
                      <FileText className="size-3.5" /> {release.fileCount}
                    </span>
                  )}
                  {release.bomCount > 0 && (
                    <span className="flex items-center gap-1">
                      <Layers className="size-3.5" /> {release.bomCount}
                    </span>
                  )}
                </div>

                <a
                  href={`/api/releases/${release.id}/zip`}
                  className="shrink-0 rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={`Download ${release.name} as ZIP`}
                  title="Download ZIP"
                >
                  <Download className="size-4" />
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </PageContainer>
  );
}
