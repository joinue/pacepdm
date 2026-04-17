import { NextRequest, NextResponse } from "next/server";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { revokeShareToken } from "@/lib/share-tokens";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.SHARE_CREATE)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const revoked = await revokeShareToken(tenantUser.tenantId, id);
    if (!revoked) {
      return NextResponse.json({ error: "Share link not found" }, { status: 404 });
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "share.revoke",
      entityType: revoked.resourceType,
      entityId: revoked.resourceId,
      details: { tokenId: id },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Failed to revoke share link:", err);
    const message = err instanceof Error ? err.message : "Failed to revoke share link";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
