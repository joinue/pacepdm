"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { FormattedDate } from "@/components/ui/formatted-date";
import { Download, Link as LinkIcon, Package, FileText, Layers, ExternalLink } from "lucide-react";
import { ShareDialog } from "@/components/share/share-dialog";
import type { ReleaseRow } from "@/lib/releases";

export function ReleasePageClient({ release }: { release: ReleaseRow }) {
  const [shareOpen, setShareOpen] = useState(false);
  const { manifest } = release;

  return (
    <>
      <div className="max-w-5xl mx-auto p-6 space-y-6">
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Release
            </div>
            <h1 className="text-2xl font-semibold truncate">{release.name}</h1>
            <div className="text-sm text-muted-foreground flex items-center gap-3 flex-wrap">
              <Link
                href={`/ecos`}
                className="hover:text-foreground underline-offset-2 hover:underline"
              >
                {release.ecoNumber}
              </Link>
              <span>&middot;</span>
              <FormattedDate date={release.releasedAt} variant="datetime" />
              <span>&middot;</span>
              <span>
                {manifest.parts.length} part{manifest.parts.length === 1 ? "" : "s"}
                {", "}
                {manifest.files.length} file{manifest.files.length === 1 ? "" : "s"}
                {manifest.boms.length > 0 && (
                  <>
                    {", "}
                    {manifest.boms.length} BOM{manifest.boms.length === 1 ? "" : "s"}
                  </>
                )}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={() => setShareOpen(true)}>
              <LinkIcon className="w-4 h-4 mr-1.5" /> Share link
            </Button>
            <a
              href={`/api/releases/${release.id}/zip`}
              className="inline-flex h-7 items-center gap-1 rounded-full bg-black px-2.5 text-[0.8rem] font-medium text-white hover:bg-black/80 dark:bg-white dark:text-black dark:hover:bg-white/80"
            >
              <Download className="w-3.5 h-3.5" /> Download ZIP
            </a>
          </div>
        </div>

        {release.note && (
          <Card>
            <CardContent className="text-sm p-4">{release.note}</CardContent>
          </Card>
        )}

        {/* ── Parts ──────────────────────────────────────────────── */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
            <Package className="w-4 h-4" /> Parts ({manifest.parts.length})
          </h2>
          {manifest.parts.length === 0 ? (
            <div className="text-xs text-muted-foreground py-4 text-center border border-dashed rounded-md">
              No parts in this release.
            </div>
          ) : (
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Part #</th>
                    <th className="text-left px-3 py-2 font-medium">Name</th>
                    <th className="text-left px-3 py-2 font-medium">From</th>
                    <th className="text-left px-3 py-2 font-medium">To</th>
                    <th className="text-left px-3 py-2 font-medium">State</th>
                  </tr>
                </thead>
                <tbody>
                  {manifest.parts.map((p) => (
                    <tr key={p.partId} className="border-t">
                      <td className="px-3 py-2 font-mono text-xs">
                        <Link href={`/parts/${p.partId}`} className="hover:underline">
                          {p.partNumber}
                        </Link>
                      </td>
                      <td className="px-3 py-2">{p.name}</td>
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                        {p.fromRevision ?? "—"}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{p.toRevision}</td>
                      <td className="px-3 py-2">
                        <Badge variant="secondary">{p.lifecycleState}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── Files ──────────────────────────────────────────────── */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
            <FileText className="w-4 h-4" /> Files ({manifest.files.length})
          </h2>
          {manifest.files.length === 0 ? (
            <div className="text-xs text-muted-foreground py-4 text-center border border-dashed rounded-md">
              No files in this release.
            </div>
          ) : (
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Name</th>
                    <th className="text-left px-3 py-2 font-medium">Type</th>
                    <th className="text-left px-3 py-2 font-medium">Rev</th>
                    <th className="text-left px-3 py-2 font-medium">Version</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {manifest.files.map((f) => (
                    <tr key={f.fileId} className="border-t">
                      <td className="px-3 py-2 truncate max-w-xs">{f.fileName}</td>
                      <td className="px-3 py-2 uppercase text-xs text-muted-foreground">
                        {f.fileType}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{f.revision}</td>
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                        v{f.version}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Link
                          href={`/vault?file=${f.fileId}`}
                          className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                        >
                          Open <ExternalLink className="w-3 h-3" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── BOMs ──────────────────────────────────────────────── */}
        {manifest.boms.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
              <Layers className="w-4 h-4" /> BOMs ({manifest.boms.length})
            </h2>
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Name</th>
                    <th className="text-left px-3 py-2 font-medium">Rev</th>
                    <th className="text-left px-3 py-2 font-medium">Status</th>
                    <th className="text-right px-3 py-2 font-medium">Items</th>
                    <th className="text-right px-3 py-2 font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {manifest.boms.map((b) => (
                    <tr key={b.snapshotId} className="border-t">
                      <td className="px-3 py-2">
                        <Link href={`/boms/${b.bomId}`} className="hover:underline">
                          {b.bomName}
                        </Link>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{b.bomRevision ?? "—"}</td>
                      <td className="px-3 py-2">
                        {b.bomStatus && <Badge variant="secondary">{b.bomStatus}</Badge>}
                      </td>
                      <td className="px-3 py-2 text-right">{b.itemCount}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        ${b.flatTotalCost.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <Separator />
        <div className="text-xs text-muted-foreground">
          This release is an immutable snapshot. The files and BOMs below are
          frozen at the moment {release.ecoNumber} was implemented — later
          revisions won&apos;t change what this page shows.
        </div>
      </div>

      <ShareDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        resourceType="release"
        resourceId={release.id}
        resourceName={release.name}
      />
    </>
  );
}
