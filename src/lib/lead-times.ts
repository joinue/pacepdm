// Equipment lead times: the buckets sales quotes in, and when a number has
// gone stale.
//
// This started as PACE_Equipment_Lead_Time_Tracker_V1.xlsx — a sheet sales
// asked engineering to keep current. Two things a spreadsheet cannot do are
// the point of moving it here: the app stamps who changed a value and when
// (the sheet asked people to type both), and a value nobody has touched for a
// month says so, instead of being quoted as if it were today's.

/**
 * The lead times a value may take, in the order they are offered — the
 * dropdown from the sheet, unchanged, because it is how sales already quotes.
 *
 * Free text in the database rather than a CHECK constraint: this list is a
 * sales convention, it will change, and a refused write would reach the user
 * as a 500 with nothing useful in it. The route validates against this array,
 * so the refusal is a 400 that names the options.
 */
export const LEAD_TIME_OPTIONS = [
  "In Stock",
  "1-2 weeks",
  "2-3 weeks",
  "3-4 weeks",
  "4 weeks",
  "5-6 weeks",
  "6-8 weeks",
  "8-10 weeks",
  "10-12 weeks",
  "12+ weeks",
  "Confirm",
] as const;

export type LeadTime = (typeof LEAD_TIME_OPTIONS)[number];

export function isLeadTime(value: string): value is LeadTime {
  return (LEAD_TIME_OPTIONS as readonly string[]).includes(value);
}

/**
 * The value that means "ask before quoting". It is in the list because the
 * sheet had it: sometimes the honest answer is that nobody knows yet.
 */
export const LEAD_TIME_CONFIRM = "Confirm";

/**
 * How long a lead time stands before the page marks it stale.
 *
 * Thirty days is a quoting cycle, not a supply-chain truth — long enough that
 * a quiet month does not nag, short enough that nobody quotes a number from
 * last quarter. Sales can still read a stale value; it is shown as old rather
 * than hidden, because an old number with a date beats no number at all.
 */
export const LEAD_TIME_STALE_DAYS = 30;

export type LeadTimeFreshness = "unset" | "fresh" | "stale";

export interface LeadTimeRow {
  currentLeadTime: string | null;
  updatedAt: string | null;
}

/**
 * Whether a row's current lead time can be quoted as it stands.
 *
 *   unset — nobody has said. Sales should ask, and the page says so.
 *   fresh — set within the window.
 *   stale — set, but old enough to confirm before quoting.
 *
 * @param now injected so the page and its tests agree on "today".
 */
export function leadTimeFreshness(row: LeadTimeRow, now: Date = new Date()): LeadTimeFreshness {
  if (!row.currentLeadTime || !row.updatedAt) return "unset";
  const age = now.getTime() - new Date(row.updatedAt).getTime();
  if (Number.isNaN(age)) return "unset";
  return age > LEAD_TIME_STALE_DAYS * 24 * 60 * 60 * 1000 ? "stale" : "fresh";
}

/** Days since the value was last stated, or null when it never has been. */
export function daysSinceUpdate(row: LeadTimeRow, now: Date = new Date()): number | null {
  if (!row.updatedAt) return null;
  const age = now.getTime() - new Date(row.updatedAt).getTime();
  if (Number.isNaN(age)) return null;
  return Math.max(0, Math.floor(age / (24 * 60 * 60 * 1000)));
}

/** What the page says about a row's age, in the words a person would use. */
export function describeFreshness(row: LeadTimeRow, now: Date = new Date()): string {
  const freshness = leadTimeFreshness(row, now);
  if (freshness === "unset") return "Not set yet";
  const days = daysSinceUpdate(row, now) ?? 0;
  if (days === 0) return "Updated today";
  if (days === 1) return "Updated yesterday";
  return `Updated ${days} days ago`;
}

/**
 * A note as the reasons it holds, one per line.
 *
 * Notes started as a phrase beside a lead time ("casting delay") and became
 * the place people explain a backlog — three or four reasons, typed as a
 * list. Splitting here rather than in the page means the table, the side
 * panel and the history all read a note the same way.
 *
 * Leading bullets and dashes are stripped: people type them out of habit, and
 * rendering the list would otherwise show two.
 */
export function noteLines(note: string | null | undefined): string[] {
  return (note ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
    .filter((line) => line.length > 0);
}

/** The first reason, for a table cell, and how many more there are. */
export function noteSummary(note: string | null | undefined): {
  first: string | null;
  more: number;
} {
  const lines = noteLines(note);
  return { first: lines[0] ?? null, more: Math.max(0, lines.length - 1) };
}
