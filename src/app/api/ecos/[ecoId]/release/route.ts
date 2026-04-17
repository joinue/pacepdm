import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";
import { getReleaseForEco } from "@/lib/releases";

/**
 * GET /api/ecos/[ecoId]/release
 *
 * Returns the release for a given ECO, or 404 if the ECO hasn't been
 * implemented yet. Used by the ECO detail page to surface a "View release"
 * link once implementation has happened.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ ecoId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { ecoId } = await params;
    const db = getServiceClient();
    const release = await getReleaseForEco(db, tenantUser.tenantId, ecoId);
    if (!release) {
      return NextResponse.json({ error: "No release for this ECO" }, { status: 404 });
    }
    return NextResponse.json(release);
  } catch (err) {
    console.error("Failed to fetch release:", err);
    const message = err instanceof Error ? err.message : "Failed to fetch release";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
