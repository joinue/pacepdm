import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import {
  getApiTenantUser,
  hasPermission,
  permissionsExceedingActor,
  PERMISSIONS,
} from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { v4 as uuid } from "uuid";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z, parseBody, nonEmptyString, ilikeExact } from "@/lib/validation";
import { appEmailConfigured, sendInviteEmail } from "@/lib/email/send";

const InviteSchema = z.object({
  // Lowercased on the way in: Supabase Auth stores emails lowercased, and a
  // membership row holding another capitalisation is how one account came to
  // look like two (see the active-membership checks below).
  email: z.string().trim().toLowerCase().email("Must be a valid email"),
  fullName: nonEmptyString,
  roleId: nonEmptyString,
});

const ACTIVE_ELSEWHERE =
  "This user is active in another workspace. They must be deactivated there before they can join yours.";
const ALREADY_MEMBER = "User already exists in this workspace";

/**
 * The partial unique index from migration 054 allows one active membership
 * per auth account. It is the backstop for the checks in this route: two
 * invites racing, or a row whose email no longer matches the account's.
 */
function membershipConflict(error: { code?: string; message?: string }) {
  if (error.code !== "23505") return null;
  const message = error.message?.includes("tenant_users_one_active_per_auth_user")
    ? ACTIVE_ELSEWHERE
    : ALREADY_MEMBER;
  return NextResponse.json({ error: message }, { status: 409 });
}

const AUTH_USERS_PAGE_SIZE = 1000;

/**
 * Find an auth user by email across every page of the project's users.
 *
 * listUsers() with no arguments returns only the first page — 50 users — so
 * once the Supabase project (every tenant together) outgrew that, re-inviting
 * an existing account found nothing and failed with "already registered".
 * Supabase stores emails lowercased; the admin may not type them that way.
 */
async function findAuthUserByEmail(admin: SupabaseClient, email: string) {
  const target = email.toLowerCase();
  // Stops on an empty page rather than a short one, so a server-side cap on
  // perPage cannot end the search early. The bound is only a backstop.
  for (let page = 1; page <= 1000; page++) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: AUTH_USERS_PAGE_SIZE,
    });
    if (error) throw error;
    if (data.users.length === 0) return null;
    const match = data.users.find((u) => u.email?.toLowerCase() === target);
    if (match) return match;
  }
  return null;
}

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

    // Both lookups ignore case. They used `.eq("email")`, so inviting
    // `Bob@Acme.com` walked past Bob's `bob@acme.com` row while the auth
    // lookup below (which lowercases) still found his account — and inserted a
    // second active membership for it. findTenantUser's `.single()` then fails
    // on two rows, so Bob resolved to no workspace and was locked out of his
    // own. Any stranger could do it: sign-up is open, and every new workspace
    // makes its creator an Admin.
    const { data: existing, error: existingError } = await db
      .from("tenant_users")
      .select("id")
      .eq("tenantId", tenantUser.tenantId)
      .ilike("email", ilikeExact(email))
      .limit(1)
      .maybeSingle();
    if (existingError) throw existingError;

    if (existing) {
      return NextResponse.json({ error: ALREADY_MEMBER }, { status: 409 });
    }

    // A user can only be active in one workspace at a time. This is the early
    // check, before anything is sent; the authoritative one is by account id,
    // once the account is known, below.
    const { data: activeElsewhere, error: elsewhereError } = await db
      .from("tenant_users")
      .select("id")
      .ilike("email", ilikeExact(email))
      .eq("isActive", true)
      .neq("tenantId", tenantUser.tenantId)
      .limit(1)
      .maybeSingle();
    if (elsewhereError) throw elsewhereError;

    if (activeElsewhere) {
      return NextResponse.json({ error: ACTIVE_ELSEWHERE }, { status: 409 });
    }

    // Verify role belongs to tenant
    const { data: role } = await db
      .from("roles")
      .select("id, permissions")
      .eq("id", roleId)
      .eq("tenantId", tenantUser.tenantId)
      .single();

    if (!role) {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }

    // Privilege ceiling. Inviting someone into a role is assigning them one,
    // so it takes the same guard as changing an existing user's role in
    // users/[userId] — which had it while this route did not.
    //
    // The gap was reachable: ADMIN_USERS gates this route, and the seeded
    // Manager role holds ADMIN_USERS without holding "*". A Manager could
    // therefore invite an address they control as an Admin and come back
    // through the front door with permissions they were never granted.
    const newRolePerms = Array.isArray(role.permissions) ? (role.permissions as string[]) : [];
    const excess = permissionsExceedingActor(newRolePerms, permissions);
    if (excess.length > 0) {
      return NextResponse.json(
        {
          error: `Cannot invite someone into a role with permissions you don't hold: ${excess.join(", ")}`,
        },
        { status: 403 }
      );
    }

    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const origin = new URL(request.url).origin;

    // Create the auth user and get the invitation to them.
    //
    // This used to be inviteUserByEmail with redirectTo /auth/callback, which
    // only worked if the Supabase dashboard's invite template had been
    // customised. The default template links to Supabase's /verify endpoint,
    // which signs the invitee in with tokens in the URL #fragment (invites
    // cannot use PKCE). A server route never sees a fragment, so /auth/callback
    // found no ?code= and sent them to /login?error=missing_code.
    //
    // So the app builds the link itself: generateLink creates the user and
    // returns the hashed token without sending anything, and the email points
    // at /auth/confirm, which verifies token_hash on a click. No template or
    // redirect allowlist is involved. Only when the app has no email provider
    // configured does it fall back to Supabase's mailer, and that path still
    // depends on the template.
    const useAppEmail = appEmailConfigured();
    if (!useAppEmail) {
      console.warn(
        "[invite] RESEND_API_KEY/EMAIL_FROM not set; sending the invitation through Supabase's mailer, which depends on the dashboard invite template"
      );
    }
    const generated = useAppEmail
      ? await supabaseAdmin.auth.admin.generateLink({
          type: "invite",
          email,
          options: { data: { full_name: fullName } },
        })
      : null;
    const { data: authData, error: authError } =
      generated ??
      (await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
        data: { full_name: fullName },
        redirectTo: `${origin}/auth/confirm?next=/accept-invite`,
      }));

    if (authError) {
      // User might already exist in auth but not in this tenant
      if (
        authError.code === "email_exists" ||
        authError.message.includes("already been registered") ||
        authError.message.toLowerCase().includes("already registered") ||
        authError.message.toLowerCase().includes("already exists")
      ) {
        const existingAuthUser = await findAuthUserByEmail(supabaseAdmin, email);

        if (existingAuthUser) {
          // Check memberships by account, not by email. A membership row's
          // email is whatever was typed when it was created and can differ
          // from the account's; the account id cannot.
          const { data: memberships, error: membershipsError } = await db
            .from("tenant_users")
            .select("id, tenantId, isActive")
            .eq("authUserId", existingAuthUser.id);
          if (membershipsError) throw membershipsError;

          if (memberships?.some((m) => m.tenantId === tenantUser.tenantId)) {
            return NextResponse.json({ error: ALREADY_MEMBER }, { status: 409 });
          }
          if (memberships?.some((m) => m.isActive)) {
            return NextResponse.json({ error: ACTIVE_ELSEWHERE }, { status: 409 });
          }

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

          if (insertError) {
            const conflict = membershipConflict(insertError);
            if (conflict) return conflict;
            throw insertError;
          }

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

    if (generated) {
      const hashedToken = generated.data.properties?.hashed_token;
      if (!hashedToken) throw new Error("Supabase returned no invitation token");

      const link = new URL("/auth/confirm", origin);
      link.searchParams.set("token_hash", hashedToken);
      link.searchParams.set("type", "invite");
      link.searchParams.set("next", "/accept-invite");

      const tenant = tenantUser.tenant as { name?: string; settings?: Record<string, unknown> };
      const replyTo = tenant?.settings?.emailReplyTo;
      const sent = await sendInviteEmail({
        to: email,
        recipientName: fullName,
        inviterName: tenantUser.fullName,
        tenantId: tenantUser.tenantId,
        tenantName: tenant?.name || "PACE PDM",
        link: link.toString(),
        replyTo: typeof replyTo === "string" && replyTo ? replyTo : undefined,
      });

      // Nothing is added to the workspace when the email does not go out, so
      // the admin can simply retry: generateLink reissues the token for an
      // invitee who has not accepted yet.
      if (!sent.ok) {
        return NextResponse.json(
          { error: `The invitation email could not be sent: ${sent.reason}` },
          { status: 502 }
        );
      }
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

    if (insertError) {
      const conflict = membershipConflict(insertError);
      if (conflict) return conflict;
      throw insertError;
    }

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
