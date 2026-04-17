import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { verifyDomainOwnership } from "@/lib/sso-admin";

/**
 * Check the DNS TXT record the admin was told to add. On success,
 * flip the row from `pending_verification` → `verified`. The row is
 * still not honored by the login path — the admin must also submit
 * IdP metadata via the /activate endpoint before `signInWithSSO`
 * requests for this domain succeed.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.ADMIN_SETTINGS)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const db = getServiceClient();
    const { data: row } = await db
      .from("tenant_sso_domains")
      .select("id, domain, verificationToken, status")
      .eq("id", id)
      .eq("tenantId", tenantUser.tenantId)
      .maybeSingle();

    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (!row.verificationToken) {
      return NextResponse.json(
        { error: "This domain has no verification token — delete and re-add it" },
        { status: 400 }
      );
    }

    const result = await verifyDomainOwnership(row.domain, row.verificationToken);
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, reason: result.reason, found: result.found },
        { status: 400 }
      );
    }

    const now = new Date().toISOString();
    await db
      .from("tenant_sso_domains")
      .update({
        status: "verified",
        verifiedAt: now,
        updatedAt: now,
      })
      .eq("id", id)
      .eq("tenantId", tenantUser.tenantId);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "sso.domain.verified",
      entityType: "tenant",
      entityId: tenantUser.tenantId,
      details: { domain: row.domain },
    });

    return NextResponse.json({ ok: true, status: "verified", verifiedAt: now });
  } catch (err) {
    console.error("Failed to verify domain:", err);
    const message = err instanceof Error ? err.message : "Failed to verify domain";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
