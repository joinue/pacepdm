import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";
import { getReleaseById } from "@/lib/releases";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ releaseId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { releaseId } = await params;
    const db = getServiceClient();
    const release = await getReleaseById(db, tenantUser.tenantId, releaseId);
    if (!release) {
      return NextResponse.json({ error: "Release not found" }, { status: 404 });
    }
    return NextResponse.json(release);
  } catch (err) {
    console.error("Failed to fetch release:", err);
    const message = err instanceof Error ? err.message : "Failed to fetch release";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
