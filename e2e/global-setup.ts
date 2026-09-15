import fs from "fs";
import path from "path";
import { parse } from "dotenv";

/**
 * Refuse to run end-to-end tests against a Supabase project nobody named.
 *
 * The suite creates parts, ECOs, BOMs and files, and invites users, with no
 * teardown. It drives whatever app is at E2E_BASE_URL — by default `next dev`,
 * which reads `.env.local` — and `.env.local` points at production. So a bare
 * `npx playwright test` wrote test data into production without anyone having
 * decided it should (AUD-003 OPS-4).
 *
 * There is one Supabase project, by decision, so the suite runs against
 * production. What keeps that safe is where the data lands: everything the
 * suite creates belongs to the workspace of the E2E_EMAIL account, so that
 * account must be the Admin of a workspace used only for testing — never a
 * member of the team's. Tenant isolation keeps the rest out.
 *
 * This check makes running it a decision: E2E_SUPABASE_PROJECT must name the
 * project (the `abcd1234` in `https://abcd1234.supabase.co`), and a local app
 * must be configured for that same project.
 */
export default function globalSetup() {
  const baseURL = process.env.E2E_BASE_URL || "http://localhost:3000";
  const allowed = process.env.E2E_SUPABASE_PROJECT?.trim();
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(baseURL);
  const target = isLocal ? projectRef(localAppSupabaseUrl()) : null;

  if (!allowed) {
    throw new Error(
      [
        "E2E tests create parts, ECOs, BOMs and files and invite users, with no cleanup.",
        "They write into the workspace of the E2E_EMAIL account, so that account must be the Admin of a workspace used only for testing.",
        "Once it is, set E2E_SUPABASE_PROJECT to the Supabase project ref to confirm where the run will write.",
        target ? `The app at ${baseURL} is configured for project "${target}".` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  if (isLocal && target !== allowed) {
    throw new Error(
      `The app at ${baseURL} is configured for Supabase project "${target ?? "unknown"}", ` +
        `but E2E_SUPABASE_PROJECT is "${allowed}". Refusing to run against a project other ` +
        `than the one named.`
    );
  }
}

/**
 * The Supabase URL `next dev` will use, following Next's precedence: the
 * process environment first, then .env.development.local, .env.local,
 * .env.development and .env. If the dev server was started with a different
 * environment than this process, the check cannot see it.
 */
function localAppSupabaseUrl(): string | undefined {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL) return process.env.NEXT_PUBLIC_SUPABASE_URL;
  const root = path.join(__dirname, "..");
  for (const file of [".env.development.local", ".env.local", ".env.development", ".env"]) {
    const full = path.join(root, file);
    if (!fs.existsSync(full)) continue;
    const value = parse(fs.readFileSync(full)).NEXT_PUBLIC_SUPABASE_URL;
    if (value) return value;
  }
  return undefined;
}

function projectRef(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.split(".")[0] || null;
  } catch {
    return null;
  }
}
