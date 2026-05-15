import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let cachedClient: SupabaseClient | null = null;

export function createClient(): SupabaseClient {
  // The browser client is often constructed at the top of "use client"
  // components, which means it also instantiates during SSR/prerender —
  // where createBrowserClient throws because the public env vars aren't
  // inlined yet. Returning a deferred Proxy here keeps prerender happy
  // and surfaces a clear error if anything tries to actually use it
  // server-side (it should always be invoked in the browser).
  if (typeof window === "undefined") {
    return new Proxy({} as SupabaseClient, {
      get() {
        throw new Error(
          "Supabase browser client invoked during SSR. Use the server client instead."
        );
      },
    });
  }
  if (!cachedClient) {
    cachedClient = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
  }
  return cachedClient;
}
