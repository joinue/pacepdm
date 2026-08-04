import { withTenant, notFound } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { revokeShareToken } from "@/lib/share-tokens";
import { z, uuid } from "@/lib/validation";

const ParamsSchema = z.object({ id: uuid });

export const DELETE = withTenant(
  { permission: PERMISSIONS.SHARE_CREATE, params: ParamsSchema },
  async ({ tenantUser, params }) => {
    // revokeShareToken resolves its own client and takes the tenant explicitly.
    const revoked = await revokeShareToken(tenantUser.tenantId, params.id);
    if (!revoked) throw notFound("Share link not found");

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "share.revoke",
      entityType: revoked.resourceType,
      entityId: revoked.resourceId,
      details: { tokenId: params.id },
    });

    return { success: true };
  }
);
