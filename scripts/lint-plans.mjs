#!/usr/bin/env node
/**
 * Keeps docs/plans/ honest.
 *
 * A plan that states "28 of 98 routes wrapped" is useful exactly until someone
 * wraps the 29th and doesn't touch the doc. After that it is worse than no
 * plan: it reads as current, and the next person trusts it.
 *
 * So a plan declares the numbers it asserts in a machine-readable block, and
 * this script recomputes them from the codebase. If they have drifted, the
 * build fails and tells you the new values to paste in. Updating a plan
 * becomes a one-line diff rather than something you have to remember.
 *
 *   <!-- plan-metrics
 *   routes-wrapped: 28
 *   raw-fetch: 112
 *   -->
 *
 * Only declared metrics are checked, so a plan can assert as few as it likes —
 * including none, if it makes no numeric claims.
 *
 * Usage:
 *   node scripts/lint-plans.mjs            # verify
 *   node scripts/lint-plans.mjs --update   # rewrite the blocks with actuals
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const PLANS_DIR = join(ROOT, "docs", "plans");

// ─── Metric definitions ─────────────────────────────────────────────────────
//
// Each returns a number. Add one here when a plan needs to assert something
// new; a plan referencing an unknown metric is an error, not a silent pass.

function countFiles(dir, predicate) {
  let n = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (predicate(full)) n++;
    }
  };
  walk(dir);
  return n;
}

function grepCountFiles(dir, pattern, filePredicate) {
  let n = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (filePredicate(full) && pattern.test(readFileSync(full, "utf8"))) n++;
    }
  };
  walk(dir);
  return n;
}

/** Violation counts straight from the other linters, so there is one source. */
function lintCounts(script) {
  const out = execFileSync(process.execPath, [join(ROOT, "scripts", script), "--list"], {
    encoding: "utf8",
    maxBuffer: 64e6,
  });
  const counts = {};
  for (const line of out.split("\n")) {
    const rule = line.split("\t")[1];
    if (rule) counts[rule] = (counts[rule] || 0) + 1;
  }
  return counts;
}

let conventionCounts = null;
let tokenCounts = null;
const conventions = (rule) => () =>
  (conventionCounts ??= lintCounts("lint-conventions.mjs"))[rule] ?? 0;
const tokens = (rule) => () => (tokenCounts ??= lintCounts("lint-tokens.mjs"))[rule] ?? 0;

const isRoute = (p) => p.replace(/\\/g, "/").endsWith("/route.ts");
const isTsx = (p) => p.endsWith(".tsx");
const isMigration = (p) => /migration-\d+.*\.sql$/.test(p.replace(/\\/g, "/"));

const METRICS = {
  "routes-total": () => countFiles(join(ROOT, "src/app/api"), isRoute),
  "routes-wrapped": () =>
    grepCountFiles(join(ROOT, "src/app/api"), /\bwith(Tenant|PublicRoute|Cron)\b/, isRoute),
  "unwrapped-route": conventions("unwrapped-route"),
  "raw-fetch": conventions("raw-fetch"),
  "generic-error-toast": conventions("generic-error-toast"),
  "swallowed-error": conventions("swallowed-error"),
  "unchecked-delete": conventions("unchecked-delete"),
  "token-violations": () =>
    (tokens("arbitrary-px")() || 0) + (tokens("raw-palette")() || 0) + (tokens("hex-color")() || 0),
  "component-tests": () => countFiles(join(ROOT, "src"), (p) => p.endsWith(".test.tsx")),
  "pages-with-pageheader": () => grepCountFiles(join(ROOT, "src/app"), /\bPageHeader\b/, isTsx),

  // ── Integration gates (docs/plans/cad-erp-integration.md) ──
  // Unlike the debt counters above, these start at 0 and go UP: each is a
  // capability that does not exist yet and whose absence the plan asserts.
  /** BOM CSV import — the SolidWorks handoff. 0 until the route exists. */
  "bom-import-route": () =>
    countFiles(join(ROOT, "src/app/api/boms"), (p) =>
      p.replace(/\\/g, "/").endsWith("/import/route.ts")
    ),
  /** Migrations declaring an ERP `externalId` column. 0 until we add one. */
  "erp-external-id": () =>
    grepCountFiles(join(ROOT, "supabase/migrations"), /\bexternalId\b/, isMigration),

  // ── Change-control gates (docs/plans/change-control.md) ──
  /** Revising a released BOM. 1 since the route landed; here so the plan
   *  cannot claim the dead end still exists. */
  "bom-revise-route": () =>
    countFiles(join(ROOT, "src/app/api/boms"), (p) =>
      p.replace(/\\/g, "/").endsWith("/revise/route.ts")
    ),
  /** Migrations teaching `implement_eco` about BOM items. 0 until one does —
   *  an ECO can record a BOM revision today but implementing does not act on
   *  it, which is the biggest remaining gap in the change loop. */
  "eco-implements-boms": () =>
    grepCountFiles(
      join(ROOT, "supabase/migrations"),
      /implement_eco[\s\S]*?"?bomId"?/,
      isMigration
    ),
};

// ─── Scan ───────────────────────────────────────────────────────────────────

const BLOCK = /<!--\s*plan-metrics\s*\n([\s\S]*?)-->/;

if (!existsSync(PLANS_DIR)) {
  console.log("lint:plans — no docs/plans/ directory, nothing to check");
  process.exit(0);
}

const UPDATE = process.argv.includes("--update");
const problems = [];
let checked = 0;
let updated = 0;

for (const entry of readdirSync(PLANS_DIR)) {
  if (!entry.endsWith(".md") || entry === "README.md") continue;
  const path = join(PLANS_DIR, entry);
  const rel = relative(ROOT, path).replace(/\\/g, "/");
  const source = readFileSync(path, "utf8");

  const block = source.match(BLOCK);
  if (!block) {
    problems.push(
      `${rel}\n      no plan-metrics block. Add one so the plan cannot go stale silently,\n      or state explicitly that this plan makes no numeric claims.`
    );
    continue;
  }

  const declared = {};
  for (const line of block[1].split("\n")) {
    const m = line.match(/^\s*([a-z0-9-]+)\s*:\s*(\d+)\s*$/i);
    if (m) declared[m[1]] = Number(m[2]);
  }

  const drift = [];
  for (const [name, stated] of Object.entries(declared)) {
    const metric = METRICS[name];
    if (!metric) {
      problems.push(
        `${rel}\n      unknown metric "${name}" — add it to METRICS in scripts/lint-plans.mjs`
      );
      continue;
    }
    const actual = metric();
    checked++;
    if (actual !== stated) drift.push({ name, stated, actual });
  }

  if (drift.length === 0) continue;

  if (UPDATE) {
    let body = block[1];
    for (const d of drift) {
      body = body.replace(new RegExp(`^(\\s*${d.name}\\s*:\\s*)\\d+\\s*$`, "m"), `$1${d.actual}`);
    }
    writeFileSync(path, source.replace(BLOCK, `<!-- plan-metrics\n${body}-->`));
    updated++;
    console.log(`updated  ${rel}`);
    for (const d of drift) console.log(`           ${d.name}: ${d.stated} → ${d.actual}`);
    continue;
  }

  problems.push(
    `${rel}\n` +
      drift
        .map(
          (d) =>
            `      ${d.name}: plan says ${d.stated}, actual is ${d.actual} ` +
            `(${d.actual < d.stated ? "progress made" : "went up"})`
        )
        .join("\n")
  );
}

if (UPDATE) {
  console.log(
    updated === 0 ? "lint:plans — already current" : `lint:plans — ${updated} plan(s) updated`
  );
  process.exit(0);
}

if (problems.length > 0) {
  console.error(`\nlint:plans — ${problems.length} stale plan(s):\n`);
  for (const p of problems) console.error(`  ${p}\n`);
  console.error(
    "A plan that misstates where things stand is worse than no plan: it reads as\n" +
      "current and the next person trusts it. Update the prose to match, then run\n" +
      "`npm run lint:plans -- --update` to sync the metrics block.\n"
  );
  process.exit(1);
}

console.log(`lint:plans — clean (${checked} metric(s) across docs/plans/ match the codebase)`);
