import { cn } from "@/lib/utils";

/**
 * The small uppercase label that heads a group of fields or rows.
 *
 * One recipe, so the tracking and weight are the same everywhere. Renders as
 * an <h2> by default; pass `as="h3"` when it sits under another heading, so
 * the document outline stays honest for screen readers.
 */
export interface SectionLabelProps extends React.ComponentProps<"h2"> {
  as?: "h2" | "h3" | "h4" | "div";
  /** Right-aligned content on the same line — a count, an action link. */
  trailing?: React.ReactNode;
}

export function SectionLabel({
  as: Tag = "h2",
  trailing,
  className,
  children,
  ...props
}: SectionLabelProps) {
  const label = (
    <Tag
      className={cn(
        "text-xs font-medium uppercase tracking-wider text-muted-foreground",
        !trailing && className
      )}
      {...props}
    >
      {children}
    </Tag>
  );

  if (!trailing) return label;

  return (
    <div className={cn("flex items-center justify-between gap-2", className)}>
      {label}
      {trailing}
    </div>
  );
}
