"use client";

import { useEffect, useState } from "react";

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

export function FormattedDate({ date, variant = "datetime", className }: FormattedDateProps) {
  const [formatted, setFormatted] = useState<string>("");

  useEffect(() => {
    const d = parseAsUTC(date);
    setFormatted(variant === "date" ? d.toLocaleDateString() : d.toLocaleString());
  }, [date, variant]);

  return <span className={className}>{formatted}</span>;
}
