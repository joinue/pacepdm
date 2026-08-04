import { cn } from "@/lib/utils";

/**
 * The title block at the top of a page.
 *
 * Every dashboard page uses this. Before it existed, each page hand-rolled the
 * same three-level nest — a flex row, a div, an `<h2 className="text-2xl
 * font-bold">` and a muted `<p>` — which is how six pages ended up with four
 * different action-row alignments.
 *
 *   <PageHeader
 *     title="Roles & Permissions"
 *     description="Define what each role can do"
 *     actions={<Button size="sm">New Role</Button>}
 *   />
 *
 * Two deliberate differences from the markup it replaces:
 *
 *   - It renders an `<h1>`, not an `<h2>`. The app shell provides no page
 *     heading, so every dashboard page previously started its outline at level
 *     2 with nothing above it. Visually identical; correct for screen readers.
 *   - `actions` wraps onto its own line on small screens instead of squeezing
 *     the title. Several pages had already patched this with `flex-wrap`; now
 *     it is the default rather than something each page remembers.
 */
export interface PageHeaderProps extends Omit<React.ComponentProps<"header">, "title"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Buttons, menus, or a search field. Right-aligned from `sm` up. */
  actions?: React.ReactNode;
  /** Rendered above the title. Usually a <Breadcrumb> or a back link. */
  breadcrumb?: React.ReactNode;
  /** Rendered inline after the title — a status badge, a count. */
  badge?: React.ReactNode;
}

export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
  badge,
  className,
  ...props
}: PageHeaderProps) {
  return (
    <header className={cn("space-y-2", className)} {...props}>
      {breadcrumb}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-2xl font-bold">{title}</h1>
            {badge}
          </div>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </header>
  );
}
