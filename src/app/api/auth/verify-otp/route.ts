import { NextRequest, NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { z, parseBody } from "@/lib/validation";

const Schema = z.object({
  token_hash: z.string().min(1),
  type: z.enum(["signup", "invite", "magiclink", "recovery", "email_change", "email"]),
});

// POST-only on purpose. See src/app/auth/confirm/page.tsx for the reason.
export async function POST(request: NextRequest) {
  const parsed = await parseBody(request, Schema);
  if (!parsed.ok) return parsed.response;

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.verifyOtp({
    type: parsed.data.type as EmailOtpType,
    token_hash: parsed.data.token_hash,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
