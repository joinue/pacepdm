import { NextRequest, NextResponse } from "next/server";

// Simple in-memory token bucket for public/unauthenticated endpoints.
//
// Scope note: this keeps state in a module-level Map, so each server
// instance enforces its own limit. On a multi-instance deployment
// (Vercel's default), the effective limit is (per-instance cap) ×
// (instance count), which is acceptable at the threat model we care
// about — casual enumeration of share tokens. If we ever want strict
// cross-instance limits we'll swap this for Redis or Upstash.
//
// Token-bucket semantics:
//   - each key starts with `capacity` tokens
//   - every request costs 1 token
//   - tokens refill at `refillPerSec` per second, capped at `capacity`
//   - request is rejected when balance would go negative

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

interface LimiterConfig {
  capacity: number;
  refillPerSec: number;
}

const buckets = new Map<string, Bucket>();

// Periodic GC so abandoned IPs don't leak memory forever. Runs on the
// next request after 5 minutes of the previous cleanup — no timers.
let lastGcMs = 0;
const GC_INTERVAL_MS = 5 * 60_000;
const GC_STALE_MS = 30 * 60_000;

function gcIfDue(nowMs: number) {
  if (nowMs - lastGcMs < GC_INTERVAL_MS) return;
  lastGcMs = nowMs;
  for (const [key, b] of buckets) {
    if (nowMs - b.lastRefillMs > GC_STALE_MS) buckets.delete(key);
  }
}

function consume(key: string, config: LimiterConfig): boolean {
  const nowMs = Date.now();
  gcIfDue(nowMs);
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: config.capacity, lastRefillMs: nowMs };
    buckets.set(key, bucket);
  } else {
    const elapsedSec = (nowMs - bucket.lastRefillMs) / 1000;
    bucket.tokens = Math.min(
      config.capacity,
      bucket.tokens + elapsedSec * config.refillPerSec
    );
    bucket.lastRefillMs = nowMs;
  }
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/**
 * Pull a stable client key from a request. Vercel sets `x-forwarded-for`;
 * local dev sometimes only has the socket address. We accept the first
 * forwarded IP since later entries can be spoofed by the client.
 */
function clientKey(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

/**
 * Enforce a per-IP token bucket on a public route. Returns a 429 response
 * when exceeded; returns null when the caller should proceed.
 *
 *   const limited = enforceRateLimit(request, "share-resolve");
 *   if (limited) return limited;
 */
export function enforceRateLimit(
  request: NextRequest,
  scope: string,
  config: LimiterConfig = { capacity: 30, refillPerSec: 1 }
): NextResponse | null {
  const key = `${scope}:${clientKey(request)}`;
  if (consume(key, config)) return null;
  return NextResponse.json(
    { error: "Too many requests. Please slow down and try again shortly." },
    { status: 429, headers: { "Retry-After": "30" } }
  );
}
