import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

const SETTINGS_KEYS = [
  "maxUploadSizeMb",
  "allowedExtensions",
  "revisionScheme",
  "requireCheckoutComment",
  "emailNotifications",
  "digestFrequency",
  "autoReleasePrefix",
] as const;

export async function PUT(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];

    if (!hasPermission(permissions, PERMISSIONS.ADMIN_SETTINGS)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { name, settings } = body;

    if (!name?.trim()) {
      return NextResponse.json({ error: "Company name is required" }, { status: 400 });
    }

    // Sanitize settings — only allow known keys
    const sanitized: Record<string, unknown> = {};
    if (settings && typeof settings === "object") {
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
        name: name.trim(),
        settings: sanitized,
        updatedAt: new Date().toISOString(),
      })
      .eq("id", tenantUser.tenantId);

    await logAudit({ tenantId: tenantUser.tenantId, userId: tenantUser.id, action: "settings.update", entityType: "tenant", entityId: tenantUser.tenantId, details: { name: name.trim() } });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to update settings" }, { status: 500 });
  }
}
