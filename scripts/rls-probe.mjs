#!/usr/bin/env node
/**
 * Ground-truth RLS check against the live database.
 *
 * Migrations in this repo are applied by hand (docs/decisions/hand-applied-migrations.md),
 * so a migration file saying `enable row level security` proves nothing about
 * what is actually live. This script asks PostgREST directly, using the same
 * anon key that ships in the browser bundle, and fails if any table answers.
 *
 * It is the check that would have caught the exposure migration-039 closed:
 * before that migration, `GET /rest/v1/tenant_users` returned every user's
 * email to an unauthenticated caller, and writes to `audit_logs` were accepted.
 *
 * Both probes are non-destructive. The read is a `limit=1` select; the write is
 * an empty INSERT that Postgres always aborts — see probeWrite for why it has
 * to be an INSERT and not a DELETE.
 *
 * Usage:
 *   npm run probe:rls              # read probes (safe, no writes)
 *   npm run probe:rls -- --writes  # also probe that writes are refused
 *
 * Reads .env.local for NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.
 *
 * When you add a table, add it to LOCKED_TABLES in the same PR. A table absent
 * from this list is not covered, and this script passing says nothing about it.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ─── Tables that must return zero rows to an anonymous caller ───────────────
//
// This is every table in the schema. If a future feature needs browser access
// to one of them, move it to READABLE_TABLES below with a comment explaining
// which policy makes it safe.

const LOCKED_TABLES = [
  "approval_decisions",
  "approval_group_members",
  "approval_groups",
  "approval_history",
  "approval_reminders",
  "approval_requests",
  "approval_workflow_assignments",
  "approval_workflow_steps",
  "approval_workflows",
  "audit_logs",
  "bom_items",
  "bom_snapshots",
  "boms",
  "comment_mentions",
  "eco_items",
  "ecos",
  "file_references",
  "file_versions",
  "files",
  "folder_access",
  "folder_permissions",
  "folders",
  "lifecycle_states",
  "lifecycle_transitions",
  "lifecycles",
  "metadata_fields",
  "metadata_values",
  "notifications",
  "part_files",
  "part_vendors",
  "parts",
  "releases",
  "roles",
  "saved_searches",
  "share_token_access",
  "share_tokens",
  "tenant_sso_domains",
  "tenant_users",
  "tenants",
  "vendors",
];

/**
 * Tables an anonymous caller may legitimately read, each with the reason.
 * Empty today, deliberately: every browser read in this app goes through a
 * route handler on the service role.
 */
const READABLE_TABLES = {};

// ─── Environment ────────────────────────────────────────────────────────────

function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    const path = join(process.cwd(), file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key]) continue;
      process.env[key] = rawValue.replace(/^["']|["']$/g, "");
    }
  }
}

loadEnv();

const URL_BASE = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!URL_BASE || !ANON_KEY) {
  console.error(
    "probe:rls — NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set (.env.local)."
  );
  process.exit(1);
}

const PROBE_WRITES = process.argv.includes("--writes");

const headers = {
  apikey: ANON_KEY,
  Authorization: `Bearer ${ANON_KEY}`,
};

// ─── Probes ─────────────────────────────────────────────────────────────────

/**
 * A table is leaking if PostgREST returns any row. A 200 with `[]` means RLS
 * is on and denying — which is what we want. A 4xx (permission denied on the
 * relation, or an unknown relation) is also a pass.
 */
async function probeRead(table) {
  const res = await fetch(`${URL_BASE}/rest/v1/${table}?select=*&limit=1`, { headers });

  if (res.status === 404 || res.status === 400) {
    return { table, status: res.status, verdict: "absent", detail: "table not exposed" };
  }
  if (res.status === 401 || res.status === 403) {
    return { table, status: res.status, verdict: "denied", detail: "refused" };
  }

  let rows = [];
  try {
    rows = await res.json();
  } catch {
    return { table, status: res.status, verdict: "unknown", detail: "non-JSON response" };
  }

  if (Array.isArray(rows) && rows.length > 0) {
    return {
      table,
      status: res.status,
      verdict: "LEAK",
      detail: `${rows.length}+ row(s) readable anonymously`,
    };
  }
  return { table, status: res.status, verdict: "denied", detail: "zero rows" };
}

/**
 * Whether anon may WRITE. This has to be an INSERT, not a DELETE.
 *
 * A no-match DELETE cannot answer the question: with RLS on and no DELETE
 * policy, RLS narrows the row set to empty and PostgREST returns 204 — the
 * exact same 204 you get with RLS off and nothing matching the filter. An
 * earlier version of this script read that 204 as "anon holds DELETE" and
 * reported all 37 tables as leaking against a database that was fully locked
 * down, including the ones migration 023 had secured months earlier.
 *
 * An empty INSERT does answer it, because Postgres evaluates the RLS policy
 * before the NOT NULL constraints:
 *
 *   RLS blocking the write  → 42501  new row violates row-level security policy
 *   write authorised        → 23502  null value in column "id" violates not-null
 *
 * Either way the statement aborts, so nothing is written. Every table in
 * LOCKED_TABLES has at least one NOT NULL column without a default, so the
 * 23502 path cannot turn into a successful insert — and if a future table
 * breaks that assumption, the 2xx branch below catches it and says so.
 */
const RLS_DENIED = "42501";

async function probeWrite(table) {
  const res = await fetch(`${URL_BASE}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: "{}",
  });

  // A 2xx means the empty row was actually accepted. That is both a leak and a
  // stray row someone has to go delete by hand.
  if (res.ok) {
    return {
      table,
      status: res.status,
      verdict: "LEAK",
      detail: "anonymous INSERT succeeded — a row was created, delete it",
    };
  }

  let code = null;
  try {
    code = (await res.json())?.code ?? null;
  } catch {
    return { table, status: res.status, verdict: "unknown", detail: "non-JSON response" };
  }

  if (code === RLS_DENIED) {
    return { table, status: res.status, verdict: "denied", detail: "write refused by RLS" };
  }

  // PostgREST could not find the table at all — same meaning as in probeRead.
  if (code === "PGRST205" || code === "42P01") {
    return { table, status: res.status, verdict: "absent", detail: "table not exposed" };
  }

  // Anything else — a not-null, FK, or unique violation — means the privilege
  // check passed and only the data stopped the write. Anon can write here.
  return {
    table,
    status: res.status,
    verdict: "LEAK",
    detail: `anonymous INSERT authorised (aborted on ${code ?? "unknown error"}, not RLS)`,
  };
}

// ─── Run ────────────────────────────────────────────────────────────────────

const project = URL_BASE.replace(/^https?:\/\//, "").split(".")[0];
console.log(`probe:rls — probing ${project} as anon (${LOCKED_TABLES.length} tables)\n`);

const results = [];
for (const table of LOCKED_TABLES) {
  results.push(await probeRead(table));
  if (PROBE_WRITES) results.push(await probeWrite(table));
}

const leaks = results.filter((r) => r.verdict === "LEAK");
const unknown = results.filter((r) => r.verdict === "unknown");
const absent = results.filter((r) => r.verdict === "absent");

for (const r of leaks) {
  console.error(`  LEAK     ${r.table.padEnd(32)} ${r.status}  ${r.detail}`);
}
for (const r of unknown) {
  console.warn(`  unknown  ${r.table.padEnd(32)} ${r.status}  ${r.detail}`);
}
for (const r of absent) {
  console.warn(`  absent   ${r.table.padEnd(32)} ${r.status}  ${r.detail}`);
}

const covered = Object.keys(READABLE_TABLES).length;
console.log(
  `\n${results.length - leaks.length - unknown.length} probe(s) denied, ` +
    `${leaks.length} leaking, ${unknown.length} unknown, ${covered} intentionally readable.`
);

if (leaks.length > 0) {
  console.error(
    `\nAt least one table is readable or writable by an unauthenticated caller.\n` +
      `The anon key is public — it ships in the JS bundle — so this is reachable from anywhere.\n` +
      `Enable RLS on the listed tables (docs/decisions/rls-new-tables.md).`
  );
  process.exit(1);
}

if (unknown.length > 0) {
  console.error("\nSome probes were inconclusive. Investigate before trusting this result.");
  process.exit(1);
}

console.log("probe:rls — no anonymous access to any listed table.");
