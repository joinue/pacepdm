/**
 * Server-side helpers for self-serve SSO:
 *   - DNS verification of domain ownership via TXT record
 *   - Supabase Auth Admin API wrappers to register and delete SAML
 *     providers
 *
 * None of these helpers enforce permission checks — callers are
 * expected to have already gated on `ADMIN_SETTINGS`. They run with
 * the service-role key, which can read and mutate anything in the
 * project, so they never run with a user-provided client.
 */

import dns from "node:dns/promises";
import crypto from "node:crypto";

const VERIFICATION_PREFIX = "_pacepdm-verify";

export function generateVerificationToken(): string {
  // 16 bytes → 22 base64url characters. Plenty of entropy, still
  // short enough to paste into a DNS record without wrapping.
  return crypto.randomBytes(16).toString("base64url");
}

export function verificationRecordName(domain: string): string {
  return `${VERIFICATION_PREFIX}.${domain}`;
}

export interface DnsVerifyResult {
  ok: boolean;
  /** The values we found at the TXT record, for debugging. */
  found: string[];
  /** Populated when ok === false. */
  reason?: string;
}

/**
 * Resolve the verification TXT record for `domain` and check whether
 * any of its values match `expected`. Returns a structured result so
 * the admin UI can show "we saw X, you configured Y" when it fails.
 *
 * Namespaced under `_pacepdm-verify.<domain>` so we never collide with
 * the customer's existing TXT records (SPF, Google site verification,
 * etc.) on the apex.
 */
export async function verifyDomainOwnership(
  domain: string,
  expected: string
): Promise<DnsVerifyResult> {
  const name = verificationRecordName(domain);
  try {
    // resolveTxt returns string[][] because a single TXT record can be
    // split into multiple strings (255-byte chunk limit). We join each
    // record's chunks before matching.
    const records = await dns.resolveTxt(name);
    const flattened = records.map((parts) => parts.join(""));
    const match = flattened.includes(expected);
    if (match) return { ok: true, found: flattened };
    return {
      ok: false,
      found: flattened,
      reason:
        flattened.length === 0
          ? `No TXT record at ${name}`
          : `TXT record at ${name} does not contain the expected token`,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "ENODATA") {
      return {
        ok: false,
        found: [],
        reason: `No TXT record found at ${name}. If you just added it, DNS may still be propagating — retry in a minute.`,
      };
    }
    return {
      ok: false,
      found: [],
      reason: `DNS lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

interface SupabaseSsoProvider {
  id: string;
  saml?: { entity_id?: string };
  domains?: Array<{ domain: string }>;
  created_at?: string;
  updated_at?: string;
}

function supabaseAdminHeaders() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return {
    Authorization: `Bearer ${serviceKey}`,
    apikey: serviceKey,
    "Content-Type": "application/json",
  };
}

function supabaseAuthAdminUrl(path: string): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  return `${base.replace(/\/$/, "")}/auth/v1/admin/sso${path}`;
}

/**
 * Create (or update) a SAML provider in Supabase bound to this domain.
 * Supabase's SSO Admin API is REST-only — the JS SDK doesn't expose it
 * on GoTrueAdminApi at all versions, so we hit the endpoint directly.
 */
export async function createSupabaseSamlProvider(params: {
  metadataXml?: string;
  metadataUrl?: string;
  domains: string[];
}): Promise<SupabaseSsoProvider> {
  if (!params.metadataXml && !params.metadataUrl) {
    throw new Error("Either metadataXml or metadataUrl is required");
  }

  const body: Record<string, unknown> = {
    type: "saml",
    domains: params.domains,
  };
  if (params.metadataXml) body.metadata_xml = params.metadataXml;
  if (params.metadataUrl) body.metadata_url = params.metadataUrl;

  const res = await fetch(supabaseAuthAdminUrl("/providers"), {
    method: "POST",
    headers: supabaseAdminHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Supabase SSO provider create failed (${res.status}): ${text.slice(0, 500)}`
    );
  }
  return (await res.json()) as SupabaseSsoProvider;
}

export async function deleteSupabaseSamlProvider(providerId: string): Promise<void> {
  const res = await fetch(supabaseAuthAdminUrl(`/providers/${providerId}`), {
    method: "DELETE",
    headers: supabaseAdminHeaders(),
  });
  // 404 means the provider is already gone — treat as success so we
  // don't block a row delete over a reconciliation hiccup.
  if (res.ok || res.status === 404) return;
  const text = await res.text().catch(() => "");
  throw new Error(
    `Supabase SSO provider delete failed (${res.status}): ${text.slice(0, 500)}`
  );
}
