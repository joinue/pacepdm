import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";
import { z, parseBody } from "@/lib/validation";
import { DEFAULT_EMAIL_PREFS } from "@/lib/email/send";

const EmailPrefsSchema = z.object({
  approval: z.boolean(),
  transition: z.boolean(),
  checkout: z.boolean(),
  eco: z.boolean(),
  system: z.boolean(),
});

export async function GET() {
  const tenantUser = await getApiTenantUser();
  if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = getServiceClient();
  const { data } = await db
    .from("tenant_users")
    .select("emailPrefs")
    .eq("id", tenantUser.id)
    .maybeSingle();

  const prefs = {
    ...DEFAULT_EMAIL_PREFS,
    ...((data?.emailPrefs as Partial<typeof DEFAULT_EMAIL_PREFS>) || {}),
  };
  return NextResponse.json({ prefs });
}

export async function PATCH(request: NextRequest) {
  const tenantUser = await getApiTenantUser();
  if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await parseBody(request, EmailPrefsSchema);
  if (!parsed.ok) return parsed.response;

  const db = getServiceClient();
  const { error } = await db
    .from("tenant_users")
    .update({ emailPrefs: parsed.data, updatedAt: new Date().toISOString() })
    .eq("id", tenantUser.id)
    .eq("tenantId", tenantUser.tenantId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, prefs: parsed.data });
}
