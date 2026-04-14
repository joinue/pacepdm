import { NextRequest, NextResponse } from "next/server";
import { z, parseBody } from "@/lib/validation";
import {
  resolveToken,
  verifyPassword,
  unlockCookieName,
  unlockCookieValue,
} from "@/lib/share-tokens";
import { enforceRateLimit } from "@/lib/rate-limit";

const UnlockSchema = z.object({
  password: z.string().min(1).max(200),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    // Tighter limit on unlock — this is the endpoint someone would hit
    // to brute-force a password. 10 attempts per minute per IP, refilling
    // slowly. A real attacker with many IPs is still slowed, and the
    // ~192-bit token itself is unguessable even without this limit.
    const limited = enforceRateLimit(request, "share-unlock", {
      capacity: 10,
      refillPerSec: 10 / 60,
    });
    if (limited) return limited;

    const { token } = await params;
    const result = await resolveToken(token);
    if (!result.ok || !result.token.passwordHash) {
      return NextResponse.json(
        { error: "Invalid share link" },
        { status: 404 }
      );
    }

    const parsed = await parseBody(request, UnlockSchema);
    if (!parsed.ok) return parsed.response;

    const ok = await verifyPassword(parsed.data.password, result.token.passwordHash);
    if (!ok) {
      return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
    }

    // One-hour session cookie scoped to this share URL path so cookies
    // from different shared links don't leak across each other in the
    // same browser profile. Cookie value is an HMAC of the token so
    // the content endpoint can verify without a DB lookup.
    const response = NextResponse.json({ ok: true });
    response.cookies.set(unlockCookieName(token), unlockCookieValue(token), {
      path: `/api/public/share/${token}`,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60,
    });
    // Also set a cookie scoped to the viewer page so the client knows
    // it's unlocked on subsequent navigations without re-submitting.
    response.cookies.set(`${unlockCookieName(token)}_page`, "1", {
      path: `/share/${token}`,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60,
    });
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to unlock share link";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
