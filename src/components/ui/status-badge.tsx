import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { BOM_STATUS_LABELS, ECO_STATUS_LABELS, APPROVAL_STATUS_LABELS } from "@/lib/status-flows";

/**
 * The one place that decides what a status looks like.
 *
 * Before this, "released" was `bg-green-100` in one file, `bg-green-500/10
 * text-green-600 dark:text-green-400` in another, and `variant="success"` in a
 * third. Three answers to one question, and the first is invisible in dark
 * mode. Colour belongs to the status, not to the call site.
 *
 *   <StatusBadge status={bom.status} kind="bom" />
 *   <StatusBadge status={file.lifecycleState} kind="lifecycle" />
 *
 * Adding a status means adding a row here, not a colour to a component.
 */

type Tone = "success" | "warning" | "info" | "error" | "muted" | "purple" | "orange" | "default";

/**
 * Status → tone, per entity kind. Kinds are separate because the same word
 * means different things: an ECO that is APPROVED is still in flight, while a
 * BOM that is APPROVED is ready to release.
 *
 * These mappings are the ones the product already shipped — lifted verbatim
 * from the per-page `statusVariants` maps that used to be duplicated across
 * boms/constants.ts, ecos/constants.ts, search/page.tsx and global-search.tsx.
 * Consolidating them here is meant to change nothing visually; if you want a
 * status to look different, that is a separate, deliberate change made here.
 */
const TONES: Record<string, Record<string, Tone>> = {
  bom: {
    DRAFT: "muted",
    IN_REVIEW: "warning",
    APPROVED: "info",
    RELEASED: "success",
    OBSOLETE: "purple",
  },
  eco: {
    DRAFT: "muted",
    SUBMITTED: "info",
    IN_REVIEW: "warning",
    APPROVED: "success",
    REJECTED: "error",
    IMPLEMENTED: "purple",
    CLOSED: "muted",
  },
  approval: {
    PENDING: "warning",
    APPROVED: "success",
    REJECTED: "error",
    CANCELLED: "muted",
    REWORK_REQUESTED: "purple",
  },
  // ECO priority. A separate kind rather than more entries under `eco`,
  // because priority and status are different axes on the same record and a
  // shared map would let `IN_REVIEW` and `HIGH` collide.
  priority: {
    LOW: "muted",
    MEDIUM: "info",
    HIGH: "orange",
    CRITICAL: "error",
  },
  // Lifecycle states are tenant-configurable, so this maps the defaults and
  // falls back to muted for anything a customer has invented.
  lifecycle: {
    WIP: "warning",
    "In Work": "warning",
    "In Review": "info",
    Released: "success",
    Obsolete: "error",
  },
};

/**
 * The tone maps, exposed so the per-domain constants files can derive their
 * `statusVariants` from this one definition instead of restating it. Read it;
 * do not extend it at the call site.
 */
export const STATUS_TONES = TONES;

const LABELS: Record<string, Record<string, string>> = {
  bom: BOM_STATUS_LABELS,
  eco: ECO_STATUS_LABELS,
  approval: APPROVAL_STATUS_LABELS,
  priority: { LOW: "Low", MEDIUM: "Medium", HIGH: "High", CRITICAL: "Critical" },
  // Tenant-configurable, so there is no fixed label set — the raw state is the
  // label, which is what `categoryLabel`'s fallback already does.
  lifecycle: {},
};

export interface StatusBadgeProps extends React.ComponentProps<typeof Badge> {
  status: string | null | undefined;
  /** Which vocabulary `status` belongs to. */
  kind: keyof typeof TONES;
  /** Override the displayed text. Defaults to the kind's label map. */
  label?: string;
}

export function toneFor(kind: string, status: string | null | undefined): Tone {
  if (!status) return "muted";
  return TONES[kind]?.[status] ?? "muted";
}

export function StatusBadge({ status, kind, label, className, ...props }: StatusBadgeProps) {
  if (!status) return null;

  const text = label ?? LABELS[kind]?.[status] ?? status;
  const tone = toneFor(kind, status);

  return (
    <Badge variant={tone === "default" ? "default" : tone} className={cn(className)} {...props}>
      {text}
    </Badge>
  );
}

/**
 * A small filled dot in the status colour, for dense rows where a full badge
 * is too heavy (the vault file list). Same tone map, so the dot and the badge
 * can never disagree.
 */
export function StatusDot({
  status,
  kind,
  className,
}: {
  status: string | null | undefined;
  kind: keyof typeof TONES;
  className?: string;
}) {
  const tone = toneFor(kind, status);
  // Typed as Record<Tone, …> deliberately: adding a tone without a fill here is
  // then a compile error rather than a dot that silently renders with no colour.
  const FILL: Record<Tone, string> = {
    success: "bg-success",
    warning: "bg-warning",
    info: "bg-info",
    error: "bg-destructive",
    muted: "bg-neutral",
    purple: "bg-chart-4",
    orange: "bg-chart-3",
    default: "bg-primary",
  };
  const fill = FILL[tone];

  return (
    <span
      className={cn("inline-block size-2 shrink-0 rounded-full", fill, className)}
      aria-hidden="true"
    />
  );
}
