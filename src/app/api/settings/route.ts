import { withTenant } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { z, nonEmptyString } from "@/lib/validation";

const SETTINGS_KEYS = [
  "maxUploadSizeMb",
  "allowedExtensions",
  "revisionScheme",
  "requireCheckoutComment",
  "emailNotifications",
  "digestFrequency",
  "autoReleasePrefix",
  "partNumberMode",
  "partNumberPrefix",
  "partNumberPadding",
  // Refuse an approval from the person who raised the request. Off by
  // default — see docs/decisions/self-approval.md for why a hard block is the
  // wrong default for a team this size.
  "blockSelfApproval",
] as const;

const UpdateSettingsSchema = z.object({
  name: nonEmptyString,
  settings: z.record(z.string(), z.unknown()).optional(),
});

export const GET = withTenant({}, async ({ db }) => {
  // `tenants` is scoped by its own primary key, so this reads the caller's
  // tenant and no other.
  const { data: tenant } = await db.from("tenants").select("name, settings").maybeSingle();

  return {
    name: tenant?.name ?? "",
    settings: (tenant?.settings as Record<string, unknown> | null) ?? {},
  };
});

export const PUT = withTenant(
  { permission: PERMISSIONS.ADMIN_SETTINGS, body: UpdateSettingsSchema },
  async ({ db, tenantUser, body }) => {
    // Sanitize settings — only allow known keys to prevent setting arbitrary
    // attributes on the tenant row. The schema accepts any record; this
    // additional filter enforces the allow-list.
    const sanitized: Record<string, unknown> = {};
    if (body.settings) {
      for (const key of SETTINGS_KEYS) {
        if (key in body.settings) sanitized[key] = body.settings[key];
      }
    }

    await db.from("tenants").update({
      name: body.name,
      settings: sanitized,
      updatedAt: new Date().toISOString(),
    });

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "settings.update",
      entityType: "tenant",
      entityId: tenantUser.tenantId,
      details: { name: body.name },
    });

    return { success: true };
  }
);
