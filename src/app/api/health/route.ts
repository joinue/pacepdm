import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";

export async function GET() {
  const checks: Record<string, string> = {};

  checks.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ? "set" : "MISSING";
  checks.SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? "set" : "MISSING";
  checks.SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ? "set" : "MISSING";

  try {
    const db = getServiceClient();
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
}
