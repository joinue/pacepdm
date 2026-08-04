import { cn } from "@/lib/utils";

/**
 * The vertical rhythm of a page's sections, plus an optional reading-width cap.
 *
 * Deliberately does NOT set padding or a background: `AppShell` already wraps
 * the route in `p-4 md:p-6` on a card surface, so a container that padded again
 * would double the gutter on every page. This primitive owns only what the
 * pages were each hand-rolling — `space-y-6`, and a `max-w-*` on the few that
 * want one.
 */
const WIDTHS = {
  /** Full width of the shell. The default, and what most list pages use. */
  default: "",
  /** Reading width: single-column forms and feeds (settings, notifications). */
  narrow: "max-w-2xl",
  /** Slightly wider single-column: config pages with side-by-side fields (SSO). */
  medium: "max-w-3xl",
} as const;

export interface PageContainerProps extends React.ComponentProps<"div"> {
  width?: keyof typeof WIDTHS;
}

export function PageContainer({
  width = "default",
  className,
  children,
  ...props
}: PageContainerProps) {
  return (
    <div className={cn("space-y-6", WIDTHS[width], className)} {...props}>
      {children}
    </div>
  );
}
