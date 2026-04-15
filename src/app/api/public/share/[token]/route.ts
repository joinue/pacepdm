import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { resolveToken } from "@/lib/share-tokens";
import { enforceRateLimit } from "@/lib/rate-limit";

// Shape returned to the public viewer page. Deliberately minimal — enough
// to render the header, decide between "password gate" and "content",
// and show the resource's display name. No internal IDs, no tenant
// details beyond the display name for the "shared by" line.
interface ResolvedMetadata {
  status: "ok" | "revoked" | "expired" | "not_found";
  resourceType?: "file" | "bom" | "release";
  resourceName?: string;
  requiresPassword?: boolean;
  allowDownload?: boolean;
  expiresAt?: string | null;
  sharedByTenantName?: string | null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const limited = enforceRateLimit(request, "share-resolve");
    if (limited) return limited;

    const { token } = await params;
    const result = await resolveToken(token);
    if (!result.ok) {
      const payload: ResolvedMetadata = { status: result.reason };
      // 200 with a status field rather than 404 — we want the viewer
      // page to render a friendly error, not rely on HTTP status code
      // handling in the fetch layer.
      return NextResponse.json(payload, {
        headers: { "X-Robots-Tag": "noindex, nofollow" },
      });
    }

    const row = result.token;
    const db = getServiceClient();

    // Look up a display name for the resource (the only internal data
    // we leak to the public page header). Also fetch the tenant name
    // for the "shared by Acme Inc" footer line.
    let resourceName: string | null = null;
    if (row.resourceType === "file") {
      const { data } = await db
        .from("files")
        .select("name")
        .eq("id", row.resourceId)
        .eq("tenantId", row.tenantId)
        .single();
      resourceName = (data?.name as string | undefined) ?? null;
    } else if (row.resourceType === "bom") {
      const { data } = await db
        .from("boms")
        .select("name")
        .eq("id", row.resourceId)
        .eq("tenantId", row.tenantId)
        .single();
      resourceName = (data?.name as string | undefined) ?? null;
    } else {
      // release
      const { data } = await db
        .from("releases")
        .select("name")
        .eq("id", row.resourceId)
        .eq("tenantId", row.tenantId)
        .single();
      resourceName = (data?.name as string | undefined) ?? null;
    }
    if (!resourceName) {
      const payload: ResolvedMetadata = { status: "not_found" };
      return NextResponse.json(payload, {
        headers: { "X-Robots-Tag": "noindex, nofollow" },
      });
    }

    const { data: tenant } = await db
      .from("tenants")
      .select("name")
      .eq("id", row.tenantId)
      .single();

    const payload: ResolvedMetadata = {
      status: "ok",
      resourceType: row.resourceType,
      resourceName,
      requiresPassword: !!row.passwordHash,
      allowDownload: row.allowDownload,
      expiresAt: row.expiresAt,
      sharedByTenantName: (tenant?.name as string | undefined) ?? null,
    };
    return NextResponse.json(payload, {
      headers: { "X-Robots-Tag": "noindex, nofollow" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to resolve share link";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
