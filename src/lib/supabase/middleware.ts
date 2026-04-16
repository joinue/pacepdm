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
  // pacepdm.com (apex)       → marketing only, all auth happens on app.
  // app.pacepdm.com          → the application (login, dashboard, etc.)
  // localhost / 127.0.0.1    → treated as the app host for dev.
  //
  // Auth cookies are scoped to the host that set them. If a user logs
  // in on pacepdm.com, the cookie won't ride on requests to
  // app.pacepdm.com. To avoid this split-brain, the apex domain NEVER
  // serves login/register — it either shows marketing (unauthenticated)
  // or redirects to the app subdomain (authenticated or auth-page hit).

  const host = request.headers.get("host") || "";
  const isAppHost = host.startsWith("app.") || host.includes("localhost") || host.includes("127.0.0.1");

  if (!isAppHost) {
    // Apex domain: derive the app origin for redirects.
    const appOrigin = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "")
      || `https://app.${host}`;

    // Authenticated users on the apex domain should be on app. so their
    // session cookie stays consistent. Redirect with the current path.
    if (user) {
      return NextResponse.redirect(
        new URL(request.nextUrl.pathname + request.nextUrl.search, appOrigin)
      );
    }

    // Unauthenticated users hitting auth pages on the apex domain need
    // to be routed to app. so the auth cookie lands on the right host.
    if (
      request.nextUrl.pathname.startsWith("/login") ||
      request.nextUrl.pathname.startsWith("/register") ||
      request.nextUrl.pathname.startsWith("/forgot-password") ||
      request.nextUrl.pathname.startsWith("/reset-password") ||
      request.nextUrl.pathname.startsWith("/accept-invite") ||
      request.nextUrl.pathname.startsWith("/auth")
    ) {
      return NextResponse.redirect(
        new URL(request.nextUrl.pathname + request.nextUrl.search, appOrigin)
      );
    }

    // Marketing and public pages: serve on the apex domain.
    if (
      request.nextUrl.pathname === "/" ||
      request.nextUrl.pathname.startsWith("/marketing") ||
      request.nextUrl.pathname.startsWith("/share/") ||
      request.nextUrl.pathname.startsWith("/api")
    ) {
      // Rewrite / to /marketing so the URL stays clean in the browser.
      if (request.nextUrl.pathname === "/") {
        const url = request.nextUrl.clone();
        url.pathname = "/marketing";
        return NextResponse.rewrite(url);
      }
      return supabaseResponse;
    }

    // Everything else on the apex domain → redirect to app.
    return NextResponse.redirect(
      new URL(request.nextUrl.pathname + request.nextUrl.search, appOrigin)
    );
  }

  // ── App subdomain / localhost ────────────────────────────────────────

  // Redirect unauthenticated users to login (except for auth pages and API
  // routes — API routes handle their own auth and a redirect would turn a
  // POST into a 405 on /login).
  if (
    !user &&
    !request.nextUrl.pathname.startsWith("/login") &&
    !request.nextUrl.pathname.startsWith("/register") &&
    !request.nextUrl.pathname.startsWith("/forgot-password") &&
    !request.nextUrl.pathname.startsWith("/reset-password") &&
    !request.nextUrl.pathname.startsWith("/accept-invite") &&
    !request.nextUrl.pathname.startsWith("/auth") &&
    !request.nextUrl.pathname.startsWith("/api") &&
    !request.nextUrl.pathname.startsWith("/share/") &&
    !request.nextUrl.pathname.startsWith("/marketing")
  ) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Redirect authenticated users away from auth pages
  if (
    user &&
    (request.nextUrl.pathname.startsWith("/login") ||
      request.nextUrl.pathname.startsWith("/register"))
  ) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
