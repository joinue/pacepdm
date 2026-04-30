import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { resolveToken, logShareAccess } from "@/lib/share-tokens";
import { enforceRateLimit, getClientIp } from "@/lib/rate-limit";

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
      // Log meaningful failures (revoked / expired) — these have a real
      // tokenId. `not_found` is intentionally NOT logged: we'd have no
      // tokenId to scope to, and a token-guesser could otherwise flood
      // the table. The rate limiter is the right defense for that case.
      if (result.reason !== "not_found") {
        // We don't have the row here, but resolveToken's failure branches
        // for revoked/expired imply the row exists; refetch lightly to
        // capture the tenant + token id for the audit row.
        const db = getServiceClient();
        const { data: row } = await db
          .from("share_tokens")
          .select("id, tenantId, resourceType, resourceId")
          .eq("token", token)
          .single();
        if (row) {
          logShareAccess({
            tenantId: row.tenantId as string,
            tokenId: row.id as string,
            resourceType: row.resourceType as "file" | "bom" | "release",
            resourceId: row.resourceId as string,
            action: "resolve",
            success: false,
            failureReason: result.reason,
            ipAddress: getClientIp(request),
            userAgent: request.headers.get("user-agent"),
          });
        }
      }
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
    logShareAccess({
      tenantId: row.tenantId,
      tokenId: row.id,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      action: "resolve",
      ipAddress: getClientIp(request),
      userAgent: request.headers.get("user-agent"),
    });

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
    console.error("Failed to resolve share link:", err);
    const message = err instanceof Error ? err.message : "Failed to resolve share link";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
