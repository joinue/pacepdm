import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const checks: Record<string, string> = {};

  // Check env vars
  checks.DATABASE_URL = process.env.DATABASE_URL ? "set" : "MISSING";
  checks.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ? "set" : "MISSING";

  // Test database connection
  try {
    await prisma.$queryRaw`SELECT 1 as ok`;
    checks.database = "connected";
  } catch (error) {
    checks.database = `FAILED: ${error instanceof Error ? error.message : String(error)}`;
  }

  const healthy = checks.database === "connected";

  return NextResponse.json(
    { status: healthy ? "ok" : "error", checks },
    { status: healthy ? 200 : 500 }
  );
}
