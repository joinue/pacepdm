/**
 * People as the feed's joins return them: `author:tenant_users(...)` comes
 * back as an object from PostgREST, and as an array of one from the fake in
 * tests. Both read the same way here.
 */
export type Person = { fullName: string | null } | { fullName: string | null }[] | null;

export function personName(who: Person | undefined): string | null {
  const one = Array.isArray(who) ? who[0] : who;
  return one?.fullName ?? null;
}

/** Two letters for an avatar, from whatever name we have. */
export function initials(name: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
