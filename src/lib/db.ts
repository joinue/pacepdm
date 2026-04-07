import { createClient } from "@supabase/supabase-js";

// Server-side Supabase client with service role key for database operations
// This bypasses RLS and has full access — only use on the server
export function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, serviceKey);
}
