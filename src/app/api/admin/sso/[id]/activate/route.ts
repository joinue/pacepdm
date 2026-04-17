import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { z, parseBody } from "@/lib/validation";
import { createSupabaseSamlProvider } from "@/lib/sso-admin";

const ActivateSchema = z.object({
  metadataUrl: z.string().url().optional(),
  metadataXml: z.string().min(10).optional(),
}).refine(
  (v) => !!v.metadataUrl || !!v.metadataXml,
  { message: "Provide metadataUrl or metadataXml" }
);

/**
 * Ingest the IdP SAML metadata and register the provider with
 * Supabase. Requires status='verified'. On success, the row flips to
 * 'active' and `signInWithSSO({ domain })` starts working for end
 * users. The Supabase-side provider is bound to this single domain,
 * so two tenants cannot share a provider even if their IdPs overlap.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.ADMIN_SETTINGS)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, ActivateSchema);
    if (!parsed.ok) return parsed.response;

    const { id } = await params;
    const db = getServiceClient();
    const { data: row } = await db
      .from("tenant_sso_domains")
      .select("id, domain, status, providerId")
      .eq("id", id)
      .eq("tenantId", tenantUser.tenantId)
      .maybeSingle();

    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (row.status !== "verified" && row.status !== "error") {
      return NextResponse.json(
        { error: `Domain must be verified first (current status: ${row.status})` },
        { status: 400 }
      );
    }
    if (row.providerId) {
      // Already has a provider. For MVP we refuse to double-create;
      // admin can delete and re-add to change metadata.
      return NextResponse.json(
        { error: "This domain already has a registered provider. Remove and re-add it to change the metadata." },
        { status: 409 }
      );
    }

    let provider;
    try {
      provider = await createSupabaseSamlProvider({
        metadataXml: parsed.data.metadataXml,
        metadataUrl: parsed.data.metadataUrl,
        domains: [row.domain],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Park the row in `error` so the admin can see what went wrong
      // instead of the UI silently rolling back.
      await db
        .from("tenant_sso_domains")
        .update({
          status: "error",
          updatedAt: new Date().toISOString(),
        })
        .eq("id", id);
      return NextResponse.json({ error: message }, { status: 400 });
    }

    const now = new Date().toISOString();
    await db
      .from("tenant_sso_domains")
      .update({
        status: "active",
        providerId: provider.id,
        metadataUrl: parsed.data.metadataUrl || null,
        updatedAt: now,
      })
      .eq("id", id)
      .eq("tenantId", tenantUser.tenantId);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "sso.domain.activated",
      entityType: "tenant",
      entityId: tenantUser.tenantId,
      details: { domain: row.domain, providerId: provider.id },
    });

    return NextResponse.json({
      ok: true,
      status: "active",
      providerId: provider.id,
    });
  } catch (err) {
    console.error("Failed to activate SSO:", err);
    const message = err instanceof Error ? err.message : "Failed to activate SSO";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
