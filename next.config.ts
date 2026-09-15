import type { NextConfig } from "next";

/**
 * Where the browser talks to Supabase: storage signed URLs (images, PDFs in
 * <object>, the CAD viewer's fetch), PostgREST and realtime. Falls back to any
 * Supabase project when the variable is missing at build time, so a
 * misconfigured build reports violations rather than blocking the app.
 */
function supabaseOrigins(): { https: string; wss: string } {
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    return { https: url.origin, wss: `wss://${url.host}` };
  } catch {
    return { https: "https://*.supabase.co", wss: "wss://*.supabase.co" };
  }
}

const supabase = supabaseOrigins();
const isDev = process.env.NODE_ENV === "development";

/**
 * The full policy, sent as Report-Only (AUD-003 SEC-5).
 *
 * The app had no CSP at all, and Supabase session cookies are readable by
 * JavaScript by design, so one XSS is a session. Enforcing a policy that has
 * never run against the real app risks blanking a preview or the CAD viewer
 * in production, so this one reports violations to the browser console and
 * blocks nothing. Once a pass through vault, share, BOM and CAD pages shows a
 * clean console, move it to `Content-Security-Policy`.
 *
 * 'wasm-unsafe-eval' is for the OCCT importer in the CAD viewer. 'unsafe-inline'
 * on scripts is what Next needs without nonces (see the Next CSP guide).
 */
const reportOnlyPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' blob: data: ${supabase.https}`,
  "font-src 'self' data:",
  `connect-src 'self' ${supabase.https} ${supabase.wss}`,
  `media-src 'self' blob: ${supabase.https}`,
  `object-src 'self' blob: ${supabase.https}`,
  `frame-src 'self' blob: ${supabase.https}`,
  "worker-src 'self' blob:",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Enforced from day one: none of these can break a page the app renders.
 *
 * frame-ancestors / X-Frame-Options stop the login and share pages being
 * framed by another site. nosniff stops a response being reinterpreted as a
 * different content type.
 */
const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'" },
  { key: "Content-Security-Policy-Report-Only", value: reportOnlyPolicy },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  // Packages listed here are treated as CommonJS externals — Next.js does
  // NOT bundle them, and Node.js resolves them at runtime. Required for
  // anything that pulls in platform-specific native bindings:
  //   - @napi-rs/canvas loads ./skia.<os>-<arch>.node via optional deps
  //     (@napi-rs/canvas-win32-x64-msvc etc.), which turbopack can't
  //     resolve. Bundling it breaks PDF thumbnail generation.
  //   - pdfjs-dist ships a ~15 MB legacy build and imports @napi-rs/canvas
  //     transitively in our code path; keeping it external avoids pulling
  //     the native binding into the server bundle via that path too.
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist", "sharp"],

  headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // The share token is in the path, and the token is the credential.
      // strict-origin-when-cross-origin already keeps the path out of
      // cross-origin requests; no-referrer keeps even the origin out, and keeps
      // the token safe if the global policy is ever loosened. Later entries
      // win on the same key.
      {
        source: "/share/:path*",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
};

export default nextConfig;
