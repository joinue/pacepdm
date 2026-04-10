import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { z, parseBody, nonEmptyString } from "@/lib/validation";

const SETTINGS_KEYS = [
  "maxUploadSizeMb",
  "allowedExtensions",
  "revisionScheme",
  "requireCheckoutComment",
  "emailNotifications",
  "digestFrequency",
  "autoReleasePrefix",
] as const;

const UpdateSettingsSchema = z.object({
  name: nonEmptyString,
  settings: z.record(z.string(), z.unknown()).optional(),
});

export async function PUT(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];

    if (!hasPermission(permissions, PERMISSIONS.ADMIN_SETTINGS)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, UpdateSettingsSchema);
    if (!parsed.ok) return parsed.response;
    const { name, settings } = parsed.data;

    // Sanitize settings — only allow known keys to prevent setting arbitrary
    // attributes on the tenant row. The schema accepts any record; this
    // additional filter enforces the allow-list.
    const sanitized: Record<string, unknown> = {};
    if (settings) {
      for (const key of SETTINGS_KEYS) {
        if (key in settings) {
          sanitized[key] = settings[key];
        }
      }
    }

    const db = getServiceClient();
    await db
      .from("tenants")
      .update({
        name,
        settings: sanitized,
        updatedAt: new Date().toISOString(),
      })
      .eq("id", tenantUser.tenantId);

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "settings.update", entityType: "tenant",
      entityId: tenantUser.tenantId, details: { name },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update settings";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
