import { NextResponse } from "next/server";
import { withPublicRoute } from "@/lib/api-route";

/**
 * Liveness / configuration check. Public by necessity — it is what tells you a
 * deployment is misconfigured, so it cannot require the configuration to be
 * correct first. Reports only whether each variable is present, never its value.
 */
export const GET = withPublicRoute({ name: "GET /api/health" }, async ({ db }) => {
  const checks: Record<string, string> = {};

  checks.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ? "set" : "MISSING";
  checks.SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? "set" : "MISSING";
  checks.SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ? "set" : "MISSING";

  try {
    const { data, error } = await db.from("tenants").select("id").limit(1);
    if (error) throw error;
    checks.database = `connected (${data.length} tenants found)`;
  } catch (error) {
    checks.database = `FAILED: ${error instanceof Error ? error.message : String(error)}`;
  }

  const healthy = checks.database.startsWith("connected");

  return NextResponse.json(
    { status: healthy ? "ok" : "error", checks },
    { status: healthy ? 200 : 500 }
  );
});
