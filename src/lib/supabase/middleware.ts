import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // ── Domain routing ──────────────────────────────────────────────────
  //
  // pacepdm.com (apex)       → marketing & public pages for everyone
  // app.pacepdm.com          → the application (auth, dashboard, etc.)
  // localhost / 127.0.0.1    → treated as the app host for dev
  //
  // The apex domain serves public content regardless of auth status.
  // Auth pages and app routes on the apex domain redirect to app.
  // The app subdomain never serves marketing — it redirects to apex.

  const host = request.headers.get("host") || "";
  const isAppHost =
    host.startsWith("app.") ||
    host.includes("localhost") ||
    host.includes("127.0.0.1");

  const pathname = request.nextUrl.pathname;

  // Public paths served on the apex domain (and allowed through on app
  // for shared links / API calls).
  const isPublicPath =
    pathname === "/" ||
    pathname.startsWith("/marketing") ||
    pathname === "/privacy" ||
    pathname === "/terms" ||
    pathname.startsWith("/share/") ||
    pathname.startsWith("/api");

  const isAuthPath =
    pathname.startsWith("/login") ||
    pathname.startsWith("/register") ||
    pathname.startsWith("/forgot-password") ||
    pathname.startsWith("/reset-password") ||
    pathname.startsWith("/accept-invite") ||
    pathname.startsWith("/auth");

  // ── Apex domain (pacepdm.com) ───────────────────────────────────────

  if (!isAppHost) {
    const appOrigin =
      process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
      `https://app.${host}`;

    // Public pages: serve to everyone, logged-in or not.
    if (isPublicPath) {
      if (pathname === "/") {
        const url = request.nextUrl.clone();
        url.pathname = "/marketing";
        return NextResponse.rewrite(url);
      }
      return supabaseResponse;
    }

    // Auth pages and app routes: redirect to app subdomain.
    return NextResponse.redirect(
      new URL(pathname + request.nextUrl.search, appOrigin)
    );
  }

  // ── App subdomain (app.pacepdm.com) / localhost ─────────────────────

  // Marketing / legal pages on the app subdomain → redirect to apex.
  const isMarketingPath =
    pathname.startsWith("/marketing") ||
    pathname === "/privacy" ||
    pathname === "/terms";

  if (isMarketingPath) {
    const apexOrigin =
      process.env.NEXT_PUBLIC_MARKETING_URL?.replace(/\/$/, "") ||
      `https://${host.replace(/^app\./, "")}`;
    return NextResponse.redirect(
      new URL(pathname + request.nextUrl.search, apexOrigin)
    );
  }

  // Unauthenticated users → login (except auth pages, API, shared links).
  if (!user && !isAuthPath && !pathname.startsWith("/api") && !pathname.startsWith("/share/")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Authenticated users on auth pages → dashboard.
  if (user && (pathname.startsWith("/login") || pathname.startsWith("/register"))) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
