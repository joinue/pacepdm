import {
  randomBytes,
  scrypt as scryptCb,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { v4 as uuid } from "uuid";
import { getServiceClient } from "@/lib/db";

// Node's scrypt wrapped for async/await. We use scrypt (built in) instead
// of bcrypt so we don't add a new dependency just for share-link passwords.
// scrypt is memory-hard and a fine fit at this threat model — casual
// attackers fishing for shared drawings, not nation-state adversaries.
const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number
) => Promise<Buffer>;

// ─── Types ────────────────────────────────────────────────────────────────

export type ShareResourceType = "file" | "bom" | "release";

export interface ShareTokenRow {
  id: string;
  tenantId: string;
  token: string;
  resourceType: ShareResourceType;
  resourceId: string;
  createdById: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  allowDownload: boolean;
  passwordHash: string | null;
  label: string | null;
  accessCount: number;
  lastAccessedAt: string | null;
}

export interface ResolveResult {
  ok: true;
  token: ShareTokenRow;
}

export interface ResolveFailure {
  ok: false;
  reason: "not_found" | "revoked" | "expired";
}

// ─── Token generation ─────────────────────────────────────────────────────

/**
 * Generate a URL-safe token for a new share link. 24 random bytes → ~32
 * characters of base64url. That's ~192 bits of entropy, so guessing a
 * valid token requires at least 2^96 attempts on average even against
 * a tenant with millions of links (birthday bound). The rate limiter
 * on the public endpoint caps attempts well below that.
 */
export function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

// ─── Password hashing (scrypt) ────────────────────────────────────────────

/**
 * Hash a share-link password using scrypt. Stored format is `salt:hash`
 * where both parts are hex-encoded. Salt is 16 random bytes; derived
 * key is 64 bytes. These parameters match the node docs' default
 * recommendations for interactive logins.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

/**
 * Verify a password against a stored `salt:hash`. Uses timingSafeEqual
 * so incorrect passwords all take the same time to reject — no timing
 * oracle for attackers fishing for the first matching byte.
 */
export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const derived = await scrypt(password, salt, expected.length);
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// ─── Unlock cookie signing (HMAC) ─────────────────────────────────────────
//
// When a visitor submits the correct password for a password-gated
// share link, we set a short-lived, path-scoped cookie that the content
// endpoint checks. The cookie value is an HMAC over the token itself,
// keyed by SUPABASE_SERVICE_ROLE_KEY. We don't store per-unlock state
// in the DB — the signature is self-validating and the path-scope on
// the cookie keeps it isolated to that specific share URL.

const UNLOCK_COOKIE_PREFIX = "share_unlock_";

function getSigningKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is required to sign share unlock cookies"
    );
  }
  return key;
}

function signUnlock(token: string): string {
  return createHmac("sha256", getSigningKey()).update(token).digest("base64url");
}

export function unlockCookieName(token: string): string {
  // Path-scoping + a token-derived name so cookies from different
  // shares don't collide in the same browser profile.
  return `${UNLOCK_COOKIE_PREFIX}${token.slice(0, 12)}`;
}

export function unlockCookieValue(token: string): string {
  return signUnlock(token);
}

export function verifyUnlockCookie(
  token: string,
  cookieValue: string | undefined
): boolean {
  if (!cookieValue) return false;
  const expected = Buffer.from(signUnlock(token));
  const actual = Buffer.from(cookieValue);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

// ─── CRUD helpers ─────────────────────────────────────────────────────────

export interface CreateShareTokenInput {
  tenantId: string;
  createdById: string;
  resourceType: ShareResourceType;
  resourceId: string;
  expiresAt: Date | null;
  allowDownload: boolean;
  password: string | null;
  label: string | null;
}

export async function createShareToken(
  input: CreateShareTokenInput
): Promise<ShareTokenRow> {
  const db = getServiceClient();
  const row = {
    id: uuid(),
    tenantId: input.tenantId,
    token: generateToken(),
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    createdById: input.createdById,
    createdAt: new Date().toISOString(),
    expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
    revokedAt: null,
    allowDownload: input.allowDownload,
    passwordHash: input.password ? await hashPassword(input.password) : null,
    label: input.label,
    accessCount: 0,
    lastAccessedAt: null,
  };
  const { data, error } = await db
    .from("share_tokens")
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return data as ShareTokenRow;
}

export async function listShareTokensForResource(
  tenantId: string,
  resourceType: ShareResourceType,
  resourceId: string
): Promise<ShareTokenRow[]> {
  const db = getServiceClient();
  const { data, error } = await db
    .from("share_tokens")
    .select("*")
    .eq("tenantId", tenantId)
    .eq("resourceType", resourceType)
    .eq("resourceId", resourceId)
    .order("createdAt", { ascending: false });
  if (error) throw error;
  return (data ?? []) as ShareTokenRow[];
}

export async function revokeShareToken(
  tenantId: string,
  tokenId: string
): Promise<ShareTokenRow | null> {
  const db = getServiceClient();
  const { data, error } = await db
    .from("share_tokens")
    .update({ revokedAt: new Date().toISOString() })
    .eq("id", tokenId)
    .eq("tenantId", tenantId)
    .select()
    .single();
  if (error) return null;
  return data as ShareTokenRow;
}

/**
 * Look up a token by its URL-safe public value. Returns a discriminated
 * result: the caller can distinguish "not found" from "revoked" from
 * "expired" so the public page can render specific error copy.
 *
 * Does NOT increment the access counter — that happens in
 * `bumpAccessCount` after the caller decides the content is actually
 * being delivered (so unlock-screen hits don't inflate the counter).
 */
export async function resolveToken(
  token: string
): Promise<ResolveResult | ResolveFailure> {
  const db = getServiceClient();
  const { data, error } = await db
    .from("share_tokens")
    .select("*")
    .eq("token", token)
    .single();
  if (error || !data) return { ok: false, reason: "not_found" };
  const row = data as ShareTokenRow;
  if (row.revokedAt) return { ok: false, reason: "revoked" };
  if (row.expiresAt && new Date(row.expiresAt) < new Date()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, token: row };
}

/**
 * Increment access counter and stamp `lastAccessedAt`. Fire-and-forget
 * from the content endpoint — a failed bump shouldn't block delivery.
 */
export async function bumpAccessCount(tokenId: string): Promise<void> {
  const db = getServiceClient();
  // Read-modify-write — acceptable at expected share-link volumes.
  // If this becomes hot, swap for an atomic UPDATE ... SET accessCount
  // = accessCount + 1 via a Postgres RPC.
  const { data } = await db
    .from("share_tokens")
    .select("accessCount")
    .eq("id", tokenId)
    .single();
  const current = (data?.accessCount as number | undefined) ?? 0;
  await db
    .from("share_tokens")
    .update({
      accessCount: current + 1,
      lastAccessedAt: new Date().toISOString(),
    })
    .eq("id", tokenId);
}
