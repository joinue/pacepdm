import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z, parseBody } from "@/lib/validation";

const Schema = z.object({
  email: z.string().email("Must be a valid email"),
});

export async function POST(request: NextRequest) {
  const parsed = await parseBody(request, Schema);
  if (!parsed.ok) return parsed.response;

  // Plain client (no SSR cookies) so no PKCE code_verifier is stashed.
  // The resulting recovery email uses a non-PKCE token_hash, which means
  // the user can open the email on a different device than the one they
  // requested the reset from.
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false, flowType: "implicit" } }
  );

  const origin = new URL(request.url).origin;
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${origin}/auth/confirm?next=/reset-password`,
  });

  if (error) {
    const message = /rate.limit|too.many/i.test(error.message)
      ? "Too many reset requests. Please wait a few minutes or check your inbox for an existing reset link."
      : error.message;
    return NextResponse.json({ error: message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
