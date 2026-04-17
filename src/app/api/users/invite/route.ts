import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { v4 as uuid } from "uuid";
import { createClient } from "@supabase/supabase-js";
import { z, parseBody, nonEmptyString } from "@/lib/validation";

const InviteSchema = z.object({
  email: z.string().email("Must be a valid email"),
  fullName: nonEmptyString,
  roleId: nonEmptyString,
});

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];

    if (!hasPermission(permissions, PERMISSIONS.ADMIN_USERS)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, InviteSchema);
    if (!parsed.ok) return parsed.response;
    const { email, fullName, roleId } = parsed.data;

    const db = getServiceClient();

    // Check if user already exists in this tenant
    const { data: existing } = await db
      .from("tenant_users")
      .select("id")
      .eq("tenantId", tenantUser.tenantId)
      .eq("email", email)
      .single();

    if (existing) {
      return NextResponse.json({ error: "User already exists in this workspace" }, { status: 409 });
    }

    // Guard: if this email is active in another tenant, block the invite.
    // A user can only be active in one workspace at a time — this prevents
    // the .single() auth lookup from failing when multiple active rows exist.
    const { data: activeElsewhere } = await db
      .from("tenant_users")
      .select("id, tenant:tenants(name)")
      .eq("email", email)
      .eq("isActive", true)
      .neq("tenantId", tenantUser.tenantId)
      .limit(1)
      .maybeSingle();

    if (activeElsewhere) {
      return NextResponse.json(
        { error: "This user is active in another workspace. They must be deactivated there before they can join yours." },
        { status: 409 }
      );
    }

    // Verify role belongs to tenant
    const { data: role } = await db
      .from("roles")
      .select("id")
      .eq("id", roleId)
      .eq("tenantId", tenantUser.tenantId)
      .single();

    if (!role) {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }

    // Create auth user + send invite email via Supabase Admin API
    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const origin = new URL(request.url).origin;
    const redirectTo = `${origin}/auth/callback?next=/accept-invite`;

    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.inviteUserByEmail(
      email,
      { data: { full_name: fullName }, redirectTo }
    );

    if (authError) {
      // User might already exist in auth but not in this tenant
      if (
        authError.message.includes("already been registered") ||
        authError.message.toLowerCase().includes("already registered") ||
        authError.message.toLowerCase().includes("already exists")
      ) {
        // Look up existing auth user
        const { data: { users } } = await supabaseAdmin.auth.admin.listUsers();
        const existingAuthUser = users.find((u) => u.email === email);

        if (existingAuthUser) {
          const now = new Date().toISOString();
          const { data: newUser, error: insertError } = await db
            .from("tenant_users")
            .insert({
              id: uuid(),
              tenantId: tenantUser.tenantId,
              authUserId: existingAuthUser.id,
              email,
              fullName,
              roleId,
              isActive: true,
              createdAt: now,
              updatedAt: now,
            })
            .select()
            .single();

          if (insertError) throw insertError;

          await logAudit({
            tenantId: tenantUser.tenantId,
            userId: tenantUser.id,
            action: "user.invite",
            entityType: "user",
            entityId: newUser.id,
            details: { email, fullName, role: roleId },
          });

          return NextResponse.json({ user: newUser, alreadyExisted: true });
        }
      }
      return NextResponse.json({ error: authError.message }, { status: 400 });
    }

    // Create tenant user
    const now = new Date().toISOString();
    const { data: newUser, error: insertError } = await db
      .from("tenant_users")
      .insert({
        id: uuid(),
        tenantId: tenantUser.tenantId,
        authUserId: authData.user.id,
        email,
        fullName,
        roleId,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .select()
      .single();

    if (insertError) throw insertError;

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "user.invite",
      entityType: "user",
      entityId: newUser.id,
      details: { email, fullName },
    });

    return NextResponse.json({ user: newUser, alreadyExisted: false });
  } catch (err) {
    console.error("Invite error:", err);
    const message = err instanceof Error ? err.message : "Failed to invite user";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
