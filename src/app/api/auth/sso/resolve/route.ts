import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { emailDomain } from "@/lib/sso-jit";
import { z, parseBody } from "@/lib/validation";

/**
 * Public (unauthenticated) endpoint — given an email address, answer
 * whether the login page should route the user to SSO and with what
 * domain. The response never reveals tenant identity: we only say
 * "yes, use SSO with domain X" or "no, use password".
 *
 * The `domain` is simply the part after the `@` (lowercased); we only
 * return it when we have a matching `tenant_sso_domains` row. The
 * client then calls `supabase.auth.signInWithSSO({ domain })` which
 * requires Supabase to have its own domain→provider registration — see
 * docs/sso-setup.md.
 */

const ResolveSchema = z.object({
  email: z.string().email(),
});

export async function POST(request: NextRequest) {
  const parsed = await parseBody(request, ResolveSchema);
  if (!parsed.ok) return parsed.response;

  const domain = emailDomain(parsed.data.email);
  if (!domain) return NextResponse.json({ useSso: false });

  const db = getServiceClient();
  const { data: mapping } = await db
    .from("tenant_sso_domains")
    .select("domain, status")
    .eq("domain", domain)
    .eq("status", "active")
    .maybeSingle();

  if (!mapping) return NextResponse.json({ useSso: false });
  return NextResponse.json({ useSso: true, domain });
}
