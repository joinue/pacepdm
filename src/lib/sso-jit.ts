/**
 * Just-in-Time provisioning for SSO users.
 *
 * When a user signs in via Supabase SAML and no `tenant_users` row
 * exists for them yet, this module creates one — but only if the
 * user's email domain is explicitly registered in `tenant_sso_domains`
 * for some tenant. Otherwise we refuse to provision (returning `null`)
 * so the caller can bounce the user to /onboarding with a clear message.
 *
 * The design is deliberately "block, not merge": if a SAML-authed user
 * already has a tenant_users row in a different tenant than the one
 * their domain maps to, the existing row wins (the caller never reaches
 * this module for them). Cross-tenant migration is a support operation,
 * not a login-path side effect.
 *
 * Idempotency: two concurrent first-logins for the same user both call
 * this function. We write through ON CONFLICT on (tenantId, authUserId)
 * so the second insert becomes a no-op and both return successfully.
 */

import { getServiceClient } from "@/lib/db";

interface JitParams {
  authUserId: string;
  email: string;
  metadata: Record<string, unknown> | undefined;
}

interface JitResult {
  tenantId: string;
  tenantUserId: string;
}

export async function jitProvisionSsoUser(params: JitParams): Promise<JitResult | null> {
  const domain = emailDomain(params.email);
  if (!domain) return null;

  const db = getServiceClient();

  // Look up the SSO domain mapping. Only rows with status='active'
  // participate in JIT — pending/verified/error rows are inert. This
  // mirrors the /api/auth/sso/resolve filter and is load-bearing: an
  // unverified row must not auto-provision users.
  const { data: mapping } = await db
    .from("tenant_sso_domains")
    .select("tenantId, jitRoleId")
    .eq("domain", domain)
    .eq("status", "active")
    .maybeSingle();

  if (!mapping) return null;

  // Double-check there isn't already a row for this authUserId (race with
  // the caller's own SELECT). If there is, we're done.
  const { data: preexisting } = await db
    .from("tenant_users")
    .select("id, tenantId")
    .eq("authUserId", params.authUserId)
    .maybeSingle();
  if (preexisting) {
    return { tenantId: preexisting.tenantId, tenantUserId: preexisting.id };
  }

  const fullName = inferFullName(params.metadata, params.email);
  const now = new Date().toISOString();
  const { v4: uuid } = await import("uuid");
  const tenantUserId = uuid();

  const { error: insertErr } = await db.from("tenant_users").insert({
    id: tenantUserId,
    tenantId: mapping.tenantId,
    authUserId: params.authUserId,
    email: params.email,
    fullName,
    roleId: mapping.jitRoleId,
    isActive: true,
    ssoProvisioned: true,
    lastSsoLoginAt: now,
    createdAt: now,
    updatedAt: now,
  });

  if (insertErr) {
    // 23505 = unique_violation. A racing request won; fetch its row and
    // return success so the caller can proceed.
    if (`${insertErr.code || ""}`.startsWith("235")) {
      const { data: raced } = await db
        .from("tenant_users")
        .select("id, tenantId")
        .eq("authUserId", params.authUserId)
        .maybeSingle();
      if (raced) return { tenantId: raced.tenantId, tenantUserId: raced.id };
    }
    console.error("[sso-jit] provision failed:", insertErr);
    return null;
  }

  return { tenantId: mapping.tenantId, tenantUserId };
}

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

function inferFullName(
  metadata: Record<string, unknown> | undefined,
  email: string
): string {
  if (metadata) {
    for (const key of ["full_name", "name", "fullName"]) {
      const v = metadata[key];
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
    const first = metadata.given_name;
    const last = metadata.family_name;
    if (typeof first === "string" && typeof last === "string") {
      return `${first} ${last}`.trim();
    }
  }
  // Fall back to the local part of the email so the profile page
  // doesn't render a blank name until they update it themselves.
  const local = email.slice(0, email.lastIndexOf("@"));
  return local || email;
}
