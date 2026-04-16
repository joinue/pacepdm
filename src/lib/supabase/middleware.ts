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

  // Marketing homepage: on the apex domain (pacepdm.com, not app.pacepdm.com),
  // unauthenticated visitors hitting / see the marketing page instead of a
  // login redirect. The app subdomain and localhost skip this so developers
  // and logged-in users always get the dashboard. Authenticated users on the
  // apex domain also skip this — they see the dashboard, same as on app.
  const host = request.headers.get("host") || "";
  const isAppHost = host.startsWith("app.") || host.includes("localhost") || host.includes("127.0.0.1");
  if (
    !user &&
    !isAppHost &&
    (request.nextUrl.pathname === "/" || request.nextUrl.pathname.startsWith("/marketing"))
  ) {
    // Rewrite (not redirect) so the URL stays as / in the browser.
    const url = request.nextUrl.clone();
    url.pathname = "/marketing";
    return NextResponse.rewrite(url);
  }

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
    // Public share links: /share/:token is the viewer page for an external
    // partner with a tokenized URL. No account required. The matching data
    // routes live under /api/public/share/:token and are authenticated by
    // the token + optional password, not by Supabase session.
    !request.nextUrl.pathname.startsWith("/share/") &&
    // Marketing page is public — unauthenticated users should be able to
    // reach it directly too (the rewrite above handles the / → /marketing
    // case; this handles direct /marketing navigation).
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
