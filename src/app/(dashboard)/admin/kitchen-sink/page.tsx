import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { SectionLabel } from "@/components/ui/section-label";
import { StatusBadge, StatusDot } from "@/components/ui/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { FolderOpen, Plus } from "lucide-react";
import { BOM_STATUS_FLOW, ECO_STATUS_FLOW } from "@/lib/status-flows";

/**
 * The kitchen sink: every shared primitive, rendered.
 *
 * It exists so "does a primitive for this already exist" is a question you can
 * answer by looking, rather than by grepping and guessing. A component that is
 * hard to find gets rebuilt, and a rebuilt component is one that drifts.
 *
 * Admin-gated by the layout above. Add a section whenever you add a primitive.
 */
export const metadata = { title: "Kitchen sink" };

function Swatch({ name, className }: { name: string; className: string }) {
  return (
    <div className="space-y-1.5">
      <div className={`h-12 rounded-md border border-border ${className}`} />
      <p className="font-mono text-xs text-muted-foreground">{name}</p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 py-2">
      <span className="w-40 shrink-0 font-mono text-xs text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export default function KitchenSinkPage() {
  return (
    <PageContainer>
      <PageHeader
        title="Kitchen sink"
        description="Every shared primitive, rendered. Compose these instead of re-rolling their class recipes."
        badge={<Badge variant="outline">admin only</Badge>}
        actions={
          <Button variant="outline" render={<a href="/admin/settings">Back to settings</a>} />
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Colour tokens</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <SectionLabel>Surfaces</SectionLabel>
            <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Swatch name="bg-background" className="bg-background" />
              <Swatch name="bg-card" className="bg-card" />
              <Swatch name="bg-muted" className="bg-muted" />
              <Swatch name="bg-accent" className="bg-accent" />
            </div>
          </div>
          <div>
            <SectionLabel>Status</SectionLabel>
            <p className="mt-1 text-sm text-muted-foreground">
              Every state colour in the product resolves to one of these. Never write
              <code className="mx-1 rounded bg-muted px-1 font-mono text-xs">bg-success/10</code>
              at a call site.
            </p>
            <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Swatch name="bg-success" className="bg-success" />
              <Swatch name="bg-warning" className="bg-warning" />
              <Swatch name="bg-info" className="bg-info" />
              <Swatch name="bg-destructive" className="bg-destructive" />
              <Swatch name="bg-neutral" className="bg-neutral" />
            </div>
          </div>
          <div>
            <SectionLabel>Categorical (chart)</SectionLabel>
            <p className="mt-1 text-sm text-muted-foreground">
              For telling kinds apart where there is no good/bad axis.
            </p>
            <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Swatch name="bg-chart-1" className="bg-chart-1" />
              <Swatch name="bg-chart-2" className="bg-chart-2" />
              <Swatch name="bg-chart-3" className="bg-chart-3" />
              <Swatch name="bg-chart-4" className="bg-chart-4" />
              <Swatch name="bg-chart-5" className="bg-chart-5" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Type scale</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-muted-foreground">
            Tailwind stops at{" "}
            <code className="rounded bg-muted px-1 font-mono text-xs">text-xs</code> (12px). The
            three steps below it exist because a data-dense UI needs them — reach for one of these
            rather than an arbitrary pixel size, which the token linter rejects.
          </p>
          {(
            [
              ["text-sm", "14px"],
              ["text-xs", "12px"],
              ["text-2xs", "11px"],
              ["text-3xs", "10px"],
              ["text-4xs", "9px"],
            ] as const
          ).map(([cls, px]) => (
            <div key={cls} className="flex items-baseline gap-3 py-1">
              <span className="w-40 shrink-0 font-mono text-xs text-muted-foreground">
                {cls} · {px}
              </span>
              <span className={cls}>ECO-0042 · Bracket revision · Rev B</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>StatusBadge</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-muted-foreground">
            The one place that decides what a status looks like. Every status below is rendered from
            the same tone map, so the vault, search, and the BOM page cannot disagree.
          </p>
          <Row label="kind=bom">
            {Object.keys(BOM_STATUS_FLOW).map((s) => (
              <StatusBadge key={s} status={s} kind="bom" />
            ))}
          </Row>
          <Row label="kind=eco">
            {Object.keys(ECO_STATUS_FLOW).map((s) => (
              <StatusBadge key={s} status={s} kind="eco" />
            ))}
          </Row>
          <Row label="kind=approval">
            {["PENDING", "APPROVED", "REJECTED", "REWORK_REQUESTED", "CANCELLED"].map((s) => (
              <StatusBadge key={s} status={s} kind="approval" />
            ))}
          </Row>
          <Row label="kind=lifecycle">
            {["WIP", "In Review", "Released", "Obsolete", "Custom State"].map((s) => (
              <StatusBadge key={s} status={s} kind="lifecycle" />
            ))}
          </Row>
          <Separator className="my-3" />
          <Row label="StatusDot">
            {["DRAFT", "IN_REVIEW", "APPROVED", "RELEASED", "OBSOLETE"].map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5 text-sm">
                <StatusDot status={s} kind="bom" />
                {s}
              </span>
            ))}
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Badge</CardTitle>
        </CardHeader>
        <CardContent>
          <Row label="semantic">
            <Badge variant="default">default</Badge>
            <Badge variant="secondary">secondary</Badge>
            <Badge variant="outline">outline</Badge>
            <Badge variant="ghost">ghost</Badge>
          </Row>
          <Row label="status tones">
            <Badge variant="success">success</Badge>
            <Badge variant="warning">warning</Badge>
            <Badge variant="info">info</Badge>
            <Badge variant="error">error</Badge>
            <Badge variant="muted">muted</Badge>
          </Row>
          <Row label="categorical">
            <Badge variant="purple">purple</Badge>
            <Badge variant="orange">orange</Badge>
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Button</CardTitle>
        </CardHeader>
        <CardContent>
          <Row label="variant">
            <Button>Default</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Destructive</Button>
          </Row>
          <Row label="size">
            <Button size="sm">Small</Button>
            <Button>Default</Button>
            <Button size="lg">Large</Button>
          </Row>
          <Row label="disabled">
            <Button disabled>Disabled</Button>
            <Button variant="outline" disabled>
              Disabled
            </Button>
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>PageHeader</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="rounded-md border border-dashed border-border p-4">
            <PageHeader title="Bills of Materials" description="Assemblies and their parts." />
          </div>
          <div className="rounded-md border border-dashed border-border p-4">
            <PageHeader
              title="ECO-0042: Bracket revision"
              description="Raise the mounting hole by 2mm to clear the new harness."
              badge={<StatusBadge status="IN_REVIEW" kind="eco" />}
              actions={
                <>
                  <Button variant="outline" size="sm">
                    Export
                  </Button>
                  <Button size="sm">
                    <Plus /> Add item
                  </Button>
                </>
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>SectionLabel</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <SectionLabel>Plain</SectionLabel>
          <SectionLabel trailing={<Badge variant="muted">12</Badge>}>With trailing</SectionLabel>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>EmptyState</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={FolderOpen}
            title="No files yet"
            description="Upload a CAD file or drawing to get started."
            action={
              <Button size="sm">
                <Plus /> Upload
              </Button>
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Skeleton</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>PageContainer widths</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            <code className="rounded bg-muted px-1 font-mono text-xs">narrow</code> — reading width,
            for settings forms and single-record detail.
          </p>
          <p>
            <code className="rounded bg-muted px-1 font-mono text-xs">default</code> — list pages
            and dashboards. This page uses it.
          </p>
          <p>
            <code className="rounded bg-muted px-1 font-mono text-xs">wide</code> — data-dense
            tables and the vault browser.
          </p>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
