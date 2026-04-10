"use client";

import { useHasMounted } from "@/hooks/use-has-mounted";

interface FormattedDateProps {
  date: string | Date;
  /** "date" = toLocaleDateString(), "datetime" = toLocaleString() */
  variant?: "date" | "datetime";
  className?: string;
}

/** Ensure the value is parsed as UTC when no timezone indicator is present */
function parseAsUTC(date: string | Date): Date {
  if (date instanceof Date) return date;
  // If the string has no timezone indicator (Z, +HH:MM, -HH:MM), treat as UTC
  if (!/Z|[+-]\d{2}:\d{2}$/i.test(date)) {
    return new Date(date + "Z");
  }
  return new Date(date);
}

/**
 * Renders a date string formatted with the *user's* locale.
 *
 * Returns an empty span on the server (where the locale is unknown) and
 * the formatted value once mounted on the client. The pattern avoids the
 * SSR/CSR mismatch you'd get from calling `toLocaleString()` directly.
 */
export function FormattedDate({ date, variant = "datetime", className }: FormattedDateProps) {
  const mounted = useHasMounted();
  if (!mounted) return <span className={className} />;

  const d = parseAsUTC(date);
  const formatted = variant === "date" ? d.toLocaleDateString() : d.toLocaleString();
  return <span className={className}>{formatted}</span>;
}
