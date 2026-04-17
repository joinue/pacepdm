import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { z, parseBody, nonEmptyString } from "@/lib/validation";
import { generateVerificationToken, verificationRecordName } from "@/lib/sso-admin";

const CreateSchema = z.object({
  domain: nonEmptyString,
  jitRoleId: nonEmptyString,
});

export async function GET() {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.ADMIN_SETTINGS)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const db = getServiceClient();
    const { data, error } = await db
      .from("tenant_sso_domains")
      .select(
        "id, domain, jitRoleId, status, verificationToken, verifiedAt, providerId, metadataUrl, createdAt, role:roles!tenant_sso_domains_jitRoleId_fkey(id, name)"
      )
      .eq("tenantId", tenantUser.tenantId)
      .order("createdAt", { ascending: false });

    if (error) throw error;

    // Count existing tenant_users whose email ends in each domain, so
    // the Activate confirmation can warn "N users will be migrated to
    // SSO on their next login." Only matters before activation, but
    // we expose it for every row to keep the UI simple.
    const withCounts = await Promise.all(
      (data || []).map(async (d) => {
        const { count } = await db
          .from("tenant_users")
          .select("id", { count: "exact", head: true })
          .eq("tenantId", tenantUser.tenantId)
          .ilike("email", `%@${d.domain}`);
        return {
          ...d,
          verificationRecordName:
            d.status === "pending_verification" ? verificationRecordName(d.domain) : null,
          existingUserCount: count ?? 0,
        };
      })
    );

    return NextResponse.json({ domains: withCounts });
  } catch (err) {
    console.error("Failed to fetch SSO domains:", err);
    const message = err instanceof Error ? err.message : "Failed to fetch SSO domains";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.ADMIN_SETTINGS)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, CreateSchema);
    if (!parsed.ok) return parsed.response;

    // Normalize: strip scheme/path/whitespace, lowercase. Reject if the
    // caller passed something that doesn't parse as a bare domain.
    const raw = parsed.data.domain.trim().toLowerCase();
    const domain = normalizeDomain(raw);
    if (!domain) {
      return NextResponse.json(
        { error: "Enter a plain domain like 'acme.com' (no https://, no path)" },
        { status: 400 }
      );
    }

    // Make sure the role actually belongs to this tenant — otherwise an
    // admin could JIT users into a role from someone else's workspace.
    const db = getServiceClient();
    const { data: role } = await db
      .from("roles")
      .select("id, name")
      .eq("id", parsed.data.jitRoleId)
      .eq("tenantId", tenantUser.tenantId)
      .maybeSingle();
    if (!role) {
      return NextResponse.json({ error: "Invalid role for this workspace" }, { status: 400 });
    }

    const now = new Date().toISOString();
    const { v4: uuid } = await import("uuid");
    const id = uuid();
    const verificationToken = generateVerificationToken();

    // Row starts in `pending_verification`. It's inert until the admin
    // proves DNS ownership and ingests IdP metadata — the sso/resolve
    // endpoint only returns a domain match for status='active'.
    const { error: insertErr } = await db.from("tenant_sso_domains").insert({
      id,
      tenantId: tenantUser.tenantId,
      domain,
      jitRoleId: parsed.data.jitRoleId,
      status: "pending_verification",
      verificationToken,
      createdAt: now,
      updatedAt: now,
    });

    if (insertErr) {
      if (`${insertErr.code || ""}`.startsWith("235")) {
        return NextResponse.json(
          { error: `Domain "${domain}" is already registered for SSO` },
          { status: 409 }
        );
      }
      throw insertErr;
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "sso.domain.register",
      entityType: "tenant",
      entityId: tenantUser.tenantId,
      details: { domain, jitRoleId: parsed.data.jitRoleId },
    });

    return NextResponse.json({
      id,
      domain,
      jitRoleId: parsed.data.jitRoleId,
      role,
      status: "pending_verification",
      verificationToken,
      verificationRecordName: verificationRecordName(domain),
      createdAt: now,
    });
  } catch (err) {
    console.error("Failed to register SSO domain:", err);
    const message = err instanceof Error ? err.message : "Failed to register SSO domain";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function normalizeDomain(raw: string): string | null {
  let d = raw;
  // Strip a leading scheme if someone pastes a URL.
  d = d.replace(/^https?:\/\//, "");
  // Strip everything from the first slash onward.
  const slash = d.indexOf("/");
  if (slash >= 0) d = d.slice(0, slash);
  // Strip a leading @ if they pasted an email local-part prefix.
  d = d.replace(/^@/, "");
  // If they pasted a full email, keep only the domain.
  const at = d.lastIndexOf("@");
  if (at >= 0) d = d.slice(at + 1);

  // Now validate: at least one dot, only letters/digits/dots/hyphens.
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return null;
  return d;
}

