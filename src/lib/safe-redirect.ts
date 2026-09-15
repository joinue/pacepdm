/**
 * Reduce a `?next=` value to a path on this app, or "/".
 *
 * `/auth/confirm` pushed `next` unvalidated and `/auth/callback` built
 * `${origin}${next}`, so either could send someone off-site from a link on
 * the real domain: `next=https://evil.example` in the first, and
 * `next=@evil.example` (which turns the origin into userinfo) in the second.
 * Paired with an attacker's own magic link, that signs the victim into the
 * attacker's account and bounces them to a lookalike page.
 *
 * Resolving against a placeholder origin and requiring it to survive catches
 * every shape at once — absolute URLs, `//host`, `/\host` (which browsers
 * treat as `//host`), and `javascript:` — without enumerating them.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/")) return "/";
  const base = "http://app.invalid";
  let url: URL;
  try {
    url = new URL(next, base);
  } catch {
    return "/";
  }
  if (url.origin !== base) return "/";
  // Dot segments can resolve to a same-origin pathname that starts with `//`
  // — `/..//evil.example` does — which is protocol-relative again the moment
  // it is used as a URL.
  if (url.pathname.startsWith("//")) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}
