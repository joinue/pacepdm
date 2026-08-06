import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { PageContainer, type PageContainerProps } from "@/components/ui/page-container";
import { cn } from "@/lib/utils";

/**
 * Page-shaped loading skeletons.
 *
 * Every dashboard route is dynamic (the layout reads the session cookie), so
 * `<Link>` prefetches the route only as far as the nearest loading boundary.
 * For a long time that boundary was the single generic `(dashboard)/loading`
 * — five stat cards and an activity feed — which is the right shape for the
 * dashboard home and the wrong shape for every list, detail, and form page
 * under it. The prefetched fallback appeared instantly and then shifted hard
 * into a completely different layout.
 *
 * These compositions exist so a route-level `loading.tsx` can declare the
 * shape it actually resolves to in two or three lines, rather than each one
 * hand-rolling `<Skeleton>` stacks that drift from the page they stand in for.
 *
 * Match the skeleton to the page's real chrome — same header, same table
 * columns, same card count. A skeleton that lies is worse than a spinner.
 */

/** The `PageHeader` title block: title, optional description, optional actions. */
export function PageHeaderSkeleton({
  description = true,
  actions = false,
}: {
  description?: boolean;
  actions?: boolean;
}) {
  return (
    <header className="space-y-2">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <Skeleton className="h-8 w-48" />
          {description && <Skeleton className="h-4 w-72" />}
        </div>
        {actions && <Skeleton className="h-9 w-32 shrink-0" />}
      </div>
    </header>
  );
}

/** A bordered table with a header row and `rows` body rows. */
export function TableSkeleton({ rows = 8, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="rounded-lg border">
      <div className="flex gap-4 border-b p-3">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className="h-4 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4 border-b p-3 last:border-0">
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton key={c} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

/** The search + filter row that sits above most list pages. */
export function ToolbarSkeleton() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Skeleton className="h-9 w-64" />
      <Skeleton className="h-9 w-28" />
      <Skeleton className="h-9 w-28" />
    </div>
  );
}

/** A row of summary cards. */
export function CardGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-4 rounded" />
          </CardHeader>
          <CardContent className="space-y-2">
            <Skeleton className="h-7 w-12" />
            <Skeleton className="h-3 w-20" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** A stack of labelled form fields inside a card. */
export function FormSkeleton({ fields = 5 }: { fields?: number }) {
  return (
    <Card>
      <CardHeader className="space-y-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-64" />
      </CardHeader>
      <CardContent className="space-y-4">
        {Array.from({ length: fields }).map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
        <Skeleton className="h-9 w-24" />
      </CardContent>
    </Card>
  );
}

/** A stack of list rows — the card/divider layout most pages use over a table. */
export function ListRowsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <Card>
      <CardContent className="divide-y p-0">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 p-3">
            <Skeleton className="h-8 w-8 shrink-0 rounded-md" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
            <Skeleton className="h-5 w-16 shrink-0" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** How much room the list column keeps once a record is selected. */
const LIST_WIDTHS = {
  /** BOMs: a 16rem tree of BOM names. */
  narrow: "lg:w-64",
  /** ECOs: wider, because each row carries a status and a priority badge. */
  wide: "lg:max-w-md",
} as const;

/**
 * A master-detail page: the list column beside the record it has selected.
 *
 * This is the shape BOMs and ECOs actually resolve to — list on the **left**,
 * detail filling the rest. They both used to render the old
 * `DetailPageSkeleton`, which put its aside on the *right* at a fixed
 * `lg:w-72`, so the page appeared to swap sides and change width the moment
 * real content arrived. A skeleton that lies is worse than a spinner.
 *
 * The detail column is a `@container` mirroring the real one, so the header
 * placeholder stacks and unstacks at the same pane width the page does.
 */
export function MasterDetailSkeleton({
  listWidth = "narrow",
  listRows = 6,
  detailRows = 6,
  detailColumns = 6,
}: {
  listWidth?: keyof typeof LIST_WIDTHS;
  listRows?: number;
  detailRows?: number;
  detailColumns?: number;
}) {
  return (
    <PageContainer>
      <PageHeaderSkeleton description={false} actions />
      <div className="flex flex-col gap-4 lg:flex-row">
        <div className={cn("w-full space-y-2 lg:shrink-0", LIST_WIDTHS[listWidth])}>
          <ListRowsSkeleton rows={listRows} />
        </div>
        <div className="@container min-w-0 flex-1 space-y-4">
          <div className="flex flex-col gap-3 @4xl:flex-row @4xl:items-start @4xl:justify-between">
            {/* Thumbnail, title, and the status/revision/cost line. */}
            <div className="flex min-w-0 items-start gap-3">
              <Skeleton className="h-14 w-14 shrink-0 rounded-lg" />
              <div className="space-y-2">
                <Skeleton className="h-6 w-48" />
                <Skeleton className="h-4 w-56" />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Skeleton className="h-8 w-32" />
              <Skeleton className="h-8 w-24" />
              <Skeleton className="h-8 w-28" />
            </div>
          </div>
          <TableSkeleton rows={detailRows} columns={detailColumns} />
        </div>
      </div>
    </PageContainer>
  );
}

/**
 * A single record on its own page: title block, then stacked sections.
 *
 * Releases are the one detail page with no list beside them — they are opened
 * from a link, not picked out of a column — so they get the page's own
 * `max-w-5xl` reading width rather than a two-pane split.
 */
export function RecordPageSkeleton({ sections = 3 }: { sections?: number }) {
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-32" />
        </div>
      </div>
      {Array.from({ length: sections }).map((_, i) => (
        <section key={i} className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <TableSkeleton rows={3} columns={4} />
        </section>
      ))}
    </div>
  );
}

/**
 * The standard list page: header, toolbar, table. Covers most of the
 * dashboard, so those routes need only re-export it with row/column counts
 * that match their real table.
 */
export function ListPageSkeleton({
  rows = 8,
  columns = 4,
  actions = true,
  toolbar = true,
  width,
}: {
  rows?: number;
  columns?: number;
  actions?: boolean;
  toolbar?: boolean;
  width?: PageContainerProps["width"];
}) {
  return (
    <PageContainer width={width}>
      <PageHeaderSkeleton actions={actions} />
      {toolbar && <ToolbarSkeleton />}
      <TableSkeleton rows={rows} columns={columns} />
    </PageContainer>
  );
}
