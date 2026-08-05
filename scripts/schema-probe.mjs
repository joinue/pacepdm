#!/usr/bin/env node
/**
 * Ground-truth check that the code and the live database agree on columns.
 *
 * The sibling of `rls-probe.mjs`, and it exists for the same reason: the
 * migration files are not a ledger of what is live
 * (docs/decisions/hand-applied-migrations.md), so nothing in `npm run check`
 * can tell you a query names a column that isn't there. Typecheck cannot —
 * the Supabase client is untyped here. Unit tests cannot — they mock the
 * client. Only asking the database can.
 *
 * It was written after `POST /api/boms/[bomId]/revise` was found to have been
 * failing on *every* call for a day, in three different ways in sequence: a
 * stale CHECK constraint (23514), then a column that does not exist
 * (PGRST204 `eco_items.createdAt`), then a NOT NULL with no value
 * (23502 `changeType`). Each was hidden by the same deliberately-soft error
 * branch. One probe catches the last two before they ship.
 *
 * Checks:
 *   1. Every `.from("t")` table name exists.
 *   2. Every column named in an `.insert({...})` / `.update({...})` object
 *      literal exists on that table.
 *   3. Every `.rpc("fn")` is exposed by PostgREST.
 *   4. Every `.select("a, b, c")` column exists (embedded relations skipped).
 *
 * Known limitation, and it is the one that matters: **NOT NULL columns with
 * no default are not checked.** This probe compares names, so the missing
 * `changeType` above would still slip through it. A create path is only
 * really proven by one real call — see the non-destructive probe pattern in
 * `rls-probe.mjs`, where an insert that always fails still reveals, by which
 * constraint rejects it, whether the shape was otherwise valid.
 *
 * Usage:  npm run probe:schema
 *
 * Read-only. Nothing is written. Requires .env.local.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.argv[2] || process.cwd();
const SRC = join(ROOT, "src");

// ── live schema ───────────────────────────────────────────────────────────
function loadEnv() {
  const env = {};
  for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}
const env = loadEnv();
const spec = await (
  await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/openapi+json",
    },
  })
).json();

const SCHEMA = new Map(
  Object.entries(spec.definitions ?? {}).map(([t, d]) => [
    t,
    new Set(Object.keys(d.properties ?? {})),
  ])
);
const RPCS = new Set(
  Object.keys(spec.paths ?? {})
    .filter((p) => p.startsWith("/rpc/"))
    .map((p) => p.slice(5))
);

// ── source files ──────────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const findings = [];
function flag(kind, file, line, detail) {
  findings.push({ kind, file: relative(ROOT, file).replace(/\\/g, "/"), line, detail });
}

function lineOf(src, idx) {
  return src.slice(0, idx).split("\n").length;
}

/**
 * Column keys inside an object literal.
 *
 * Split on depth-0 commas first, then read the key off the *front* of each
 * property. Scanning for `identifier:` anywhere instead reads the middle of a
 * ternary as a key — `lifecycleState: requestedState && x ? requestedState :
 * "WIP"` reported a phantom `requestedState` column — because a conditional's
 * colon is indistinguishable from a property's once you have lost the
 * position. Splitting first keeps every ternary safely inside a value.
 */
function objectKeys(body) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let quote = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("{[(".includes(c)) depth++;
    else if ("}])".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));

  const keys = [];
  for (const part of parts) {
    const trimmed = part
      .trim()
      .replace(/^\/\/.*$/gm, "")
      .trim();
    if (!trimmed || trimmed.startsWith("...")) continue; // spread — not a key
    const withKey = /^["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*:/.exec(trimmed);
    if (withKey) {
      keys.push(withKey[1]);
      continue;
    }
    // Shorthand: `{ tenantId }` is a real column reference.
    const shorthand = /^([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
    if (shorthand) keys.push(shorthand[1]);
  }
  return keys;
}

// Balanced-brace extraction starting at the char after `(`.
function extractBalanced(src, start, open = "{", close = "}") {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return src.slice(start + 1, i);
    }
  }
  return null;
}

for (const file of walk(SRC)) {
  const src = readFileSync(file, "utf8");

  // 1. .from("table")
  for (const m of src.matchAll(/\.from\(\s*["'`]([a-z_]+)["'`]\s*\)/g)) {
    const table = m[1];
    if (!SCHEMA.has(table) && table !== "vault") {
      flag("missing-table", file, lineOf(src, m.index), `.from("${table}") — no such table`);
    }
  }

  // 3. .rpc("fn")
  for (const m of src.matchAll(/\.rpc\(\s*["'`]([a-z_0-9]+)["'`]/g)) {
    if (!RPCS.has(m[1])) {
      flag("missing-rpc", file, lineOf(src, m.index), `.rpc("${m[1]}") — not exposed by PostgREST`);
    }
  }

  // 2. .insert({...}) / .update({...}) — column existence.
  //
  // Scan BACKWARDS from each write to the nearest `.from("t")`, rejecting
  // the pair if a statement boundary sits between them. A forward regex with
  // a permissive gap matched an .insert() from a *later statement* against an
  // earlier .from(), producing 30 confident false positives on the first run
  // — including against code written minutes earlier that demonstrably works.
  // (A nested-quantifier version of that gap then hung on backtracking.)
  for (const m of src.matchAll(/\.(insert|update|upsert)\(\s*\{/g)) {
    const before = src.slice(0, m.index);
    const fromIdx = before.lastIndexOf('.from("');
    if (fromIdx === -1) continue;
    const gap = before.slice(fromIdx);
    // `;` or `await` means the chain ended and this write belongs elsewhere.
    if (/;|\bawait\b/.test(gap.slice(gap.indexOf(")") + 1))) continue;
    const table = /\.from\("([a-z_]+)"/.exec(gap)?.[1];
    const cols = table && SCHEMA.get(table);
    if (!cols) continue;

    const openIdx = src.indexOf("{", m.index + m[0].length - 1);
    const body = extractBalanced(src, openIdx);
    if (!body) continue;
    for (const key of objectKeys(body)) {
      if (cols.has(key)) continue;
      // Ternary branches inside the literal read as keys. A SCREAMING_CASE
      // token is a status constant, not a column name anyone wrote.
      if (/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
      if (key === "true" || key === "false" || key === "null") continue;
      flag(
        "missing-column",
        file,
        lineOf(src, openIdx),
        `${table}.${key} written by .${m[1]}() — no such column`
      );
    }
  }

  // 4. .from("t").select("a, b") — plain columns only.
  for (const m of src.matchAll(
    /\.from\(\s*["'`]([a-z_]+)["'`]\s*\)\s*\.select\(\s*([`"'])([\s\S]*?)\2/g
  )) {
    const table = m[1];
    const cols = SCHEMA.get(table);
    if (!cols) continue;
    const sel = m[3];
    if (sel.trim() === "*" || sel.includes("(")) continue; // embeds handled separately
    for (const raw of sel.split(",")) {
      const name = raw.trim().split(":").pop().trim();
      if (!name || name === "*") continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      if (!cols.has(name)) {
        flag(
          "missing-column",
          file,
          lineOf(src, m.index),
          `${table}.${name} selected — no such column`
        );
      }
    }
  }
}

const byKind = {};
for (const f of findings) (byKind[f.kind] ??= []).push(f);

console.log(`\nLive schema: ${SCHEMA.size} tables, ${RPCS.size} RPCs\n`);
if (!findings.length) {
  console.log("No schema/code mismatches found.\n");
} else {
  for (const [kind, list] of Object.entries(byKind)) {
    console.log(`── ${kind} (${list.length}) ──`);
    for (const f of list) console.log(`  ${f.file}:${f.line}  ${f.detail}`);
    console.log();
  }
}
console.log("RPCs live:", [...RPCS].join(", "));
