import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { deleteSupabaseSamlProvider } from "@/lib/sso-admin";

export async function DELETE(
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

    // Scope the delete to the current tenant so one admin can't remove
    // another tenant's SSO mapping by guessing an id.
    const { data: existing } = await db
      .from("tenant_sso_domains")
      .select("domain, providerId")
      .eq("id", id)
      .eq("tenantId", tenantUser.tenantId)
      .maybeSingle();

    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // If this row ever made it to `active`, there's a Supabase-side
    // SAML provider bound to the domain. Delete it before dropping
    // our row so the domain can be re-registered cleanly later.
    // Failures here are logged but non-fatal — we don't want an
    // orphaned row just because Supabase is temporarily unreachable,
    // and deleteSupabaseSamlProvider treats 404 as success.
    if (existing.providerId) {
      try {
        await deleteSupabaseSamlProvider(existing.providerId);
      } catch (err) {
        console.error(
          `[sso.delete] Supabase provider ${existing.providerId} cleanup failed:`,
          err
        );
      }
    }

    const { error } = await db
      .from("tenant_sso_domains")
      .delete()
      .eq("id", id)
      .eq("tenantId", tenantUser.tenantId);
    if (error) throw error;

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "sso.domain.remove",
      entityType: "tenant",
      entityId: tenantUser.tenantId,
      details: { domain: existing.domain, providerId: existing.providerId },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to remove SSO domain";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
