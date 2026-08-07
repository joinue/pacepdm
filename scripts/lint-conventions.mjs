#!/usr/bin/env node
/**
 * Convention gate for the rules that ESLint cannot express and that this
 * codebase has already drifted from once.
 *
 * Every rule here exists because the convention was written down, was correct,
 * and was ignored — `src/lib/README.md` mandated `useFetch` while the codebase
 * contained zero uses of it and 94 raw `fetch(` calls. Prose does not enforce.
 *
 * Uses the same ratchet as lint-tokens: existing debt is frozen in a baseline,
 * new violations fail the build, and the baseline can only shrink.
 *
 * Suppressing a single line — for the genuinely legitimate cases listed in each
 * rule — takes an explicit comment in the comment block directly above it. The
 * reason may wrap over as many lines as it needs; the marker has to appear on
 * one of them:
 *
 *   // lint-conventions-allow: raw-fetch — streams a zip body, and fetchJson
 *   // parses the response as JSON, which would consume the stream.
 *   const res = await fetch(url);
 *
 * See docs/decisions/data-fetching.md, api-route-contract.md, feature-folders.md.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { loadBaseline, writeBaseline, compare, report } from "./lib/baseline.mjs";

const ROOT = process.cwd();
const BASELINE_PATH = join(ROOT, "scripts", "conventions.baseline.json");
const SCAN_DIRS = ["src"];
const EXTENSIONS = [".ts", ".tsx"];

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      yield* walk(full);
    } else if (EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      yield full;
    }
  }
}

/** Blank comments so rule patterns never match inside them. Preserves offsets. */
function stripComments(source) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

/**
 * The child tables from src/lib/tenant-db.ts, read at lint time rather than
 * duplicated here — a second copy of this list would drift the first time
 * someone adds a table, and a rule that silently stops covering a table is
 * worse than no rule.
 */
function childTables() {
  const source = readFileSync(join(ROOT, "src", "lib", "tenant-db.ts"), "utf8");
  const block = source.match(
    /TENANT_CHILD_TABLES:\s*Record<string, string>\s*=\s*\{([\s\S]*?)\n\};/
  );
  if (!block) {
    console.error(
      "lint:conventions — could not read TENANT_CHILD_TABLES from src/lib/tenant-db.ts.\n" +
        "The child-table-direct-query rule cannot run. Fix the parser rather than removing the rule."
    );
    process.exit(1);
  }
  const names = [...block[1].matchAll(/^\s*([a-z_]+)\s*:/gm)].map((m) => m[1]);
  if (names.length === 0) {
    console.error("lint:conventions — TENANT_CHILD_TABLES parsed as empty.");
    process.exit(1);
  }
  return names;
}

const CHILD_TABLES = childTables();

/**
 * Is this line covered by an allow-comment for this rule?
 *
 * Scans upward through the contiguous block of comment lines immediately above,
 * so a justification can wrap onto as many lines as it needs. Checking only the
 * single line above would push authors toward one-line reasons, and the reason
 * is the entire point of requiring the comment.
 */
function isSuppressed(rawLines, line, ruleId) {
  const marker = `lint-conventions-allow: ${ruleId}`;
  for (let i = line - 2; i >= 0; i--) {
    const text = (rawLines[i] ?? "").trim();
    if (text.startsWith("//") || text.startsWith("*") || text.startsWith("/*")) {
      if (text.includes(marker)) return true;
      continue;
    }
    break; // first non-comment line ends the block
  }
  return false;
}

// ─── Rules ──────────────────────────────────────────────────────────────────

const RULES = [
  {
    id: "raw-fetch",
    message:
      "raw fetch() in a client component — use useFetch for reads, fetchJson for mutations (docs/decisions/data-fetching.md)",
    applies: (path, source) => isClientComponent(path, source),
    find: (source) => matchAll(source, /(?<![.\w])fetch\s*\(/g),
  },
  {
    id: "list-route-navigation",
    message:
      "navigates to a record list with no identifier — link to the record " +
      "(/boms/<id>, /parts?partId=<id>, /vault?fileId=<id>). If this really is " +
      '"back to the list", say so with a lint-conventions-allow comment',
    applies: () => true,
    // Deliberately narrow: a bare literal, no template, no query string. A
    // link that already carries an id cannot match. Catches the shape that
    // sent every BOM sub-assembly line to the parts index and every
    // where-used row to the BOM index — three separate call sites that each
    // had the id in scope and dropped it.
    find: (source) =>
      matchAll(
        source,
        /(?:router\.(?:push|replace)\(|href=)\s*["']\/(?:boms|parts|vault|ecos|vendors|releases)["']/g
      ),
  },
  {
    id: "unchecked-delete",
    message:
      "delete() result is discarded — a RESTRICT violation then reports success and audit-logs a deletion that never happened",
    applies: (path) => path.includes("/api/") || path.includes("/lib/"),
    // `await db.from("x").delete()...` with nothing destructured off it.
    // Found via folders/[folderId]: files_folderId_fkey is ON DELETE
    // RESTRICT, so a trashed file pinned its folder, Postgres refused the
    // delete, and the route returned {success:true} and wrote a
    // `folder.delete` audit row anyway. The audit log is what the compliance
    // story rests on, so a false entry in it is worse than the failed delete.
    //
    // Matches only the discarded form: `const { error } = await db...` and
    // `const { error: e } = await db...` both bind the result and pass.
    find: (source) =>
      matchAll(source, /(?<!=\s)(?<!\w)await\s+db\s*\.from\([^)]*\)\s*\.delete\s*\(/g),
  },
  {
    id: "unchecked-insert",
    message:
      "insert() result is discarded — a rejected write then reports success, and the row it was meant to create simply is not there",
    applies: (path) => path.includes("/api/") || path.includes("/lib/"),
    // The sibling of unchecked-delete, and found the same way: by a defect
    // that had already shipped.
    //
    // POST /api/parts/import wrote part_vendors without `vendorId`, NOT NULL
    // behind a RESTRICT FK since migration 009. Postgres rejected every insert
    // with 23502, the result was never bound, and the row was still reported
    // as `updated` — so the vendor column of a QuickBooks import, one of the
    // three things that import exists to bring across, had never once landed.
    //
    // A discarded insert is worse than a discarded delete in one respect: a
    // failed delete leaves data that should be gone, which is recoverable,
    // while a failed insert leaves a gap that nothing points at.
    //
    // Matches only the discarded form. `const { error } = await db...` and
    // `const { data, error } = await db...` both bind the result and pass, as
    // does anything chained into `.select()`, which cannot be used without
    // binding what it returns.
    find: (source) =>
      matchAll(source, /(?<!=\s)(?<!\w)await\s+db\s*\.from\([^)]*\)\s*\.insert\s*\(/g),
  },
  {
    id: "unchecked-update",
    message:
      "update() result is discarded — the write is reported as applied, and the row keeps its old values",
    applies: (path) => path.includes("/api/") || path.includes("/lib/"),
    // Third of the set, after unchecked-delete and unchecked-insert, and the
    // one with the quietest failure: a rejected update leaves a row that
    // already existed and still reads fine. Nothing is missing, so nothing
    // looks wrong — the value is simply the old one.
    //
    // The status transitions are the reason this is worth a rule. Every
    // lifecycle, BOM and ECO state change is an update, and one that reports
    // success without applying leaves the entity in its previous state while
    // the audit row, the notification and the UI all say it moved.
    //
    // Matches only the discarded form; anything binding `{ error }` passes.
    find: (source) =>
      matchAll(source, /(?<!=\s)(?<!\w)await\s+db\s*\.from\([^)]*\)\s*\.update\s*\(/g),
  },
  {
    id: "swallowed-error",
    message: "empty catch — a swallowed error becomes a spinner that never stops",
    applies: () => true,
    find: (source) =>
      matchAll(source, /\.catch\s*\(\s*\(\s*[\w$]*\s*\)\s*=>\s*\{\s*\}\s*\)/g).concat(
        matchAll(source, /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g)
      ),
  },
  {
    id: "generic-error-toast",
    message: "generic error toast hides the server message — use toast.error(errorMessage(err))",
    applies: () => true,
    find: (source) =>
      matchAll(
        source,
        /catch\s*(?:\([^)]*\))?\s*\{[^{}]*?toast\.error\(\s*(["'`])(?:(?!\1)[^\\$])*\1\s*[,)]/gs
      ),
  },
  {
    id: "unwrapped-route",
    message:
      "route handler resolves auth itself — use withTenant/withPublicRoute/withCron (docs/decisions/api-route-contract.md)",
    applies: (path) => path.includes("/api/") && path.endsWith("route.ts"),
    find: (source) => matchAll(source, /\b(?:getApiTenantUser|getServiceClient)\b/g),
  },
  {
    id: "service-client-in-client-component",
    message:
      "getServiceClient() in a client component — it holds the service-role key, bypasses RLS, and must never reach the browser bundle",
    // Server components fetching directly via getServiceClient() is the
    // documented pattern (docs/decisions/data-fetching.md). The danger is only
    // a "use client" file, where the import would be bundled for the browser.
    applies: (path, source) => isClientComponent(path, source),
    find: (source) => matchAll(source, /\bgetServiceClient\b/g),
  },
  {
    id: "child-table-direct-query",
    message:
      "child table queried straight off the scoped client — it has no tenantId, so ScopedDb passes it through UNFILTERED. Load its parent through db first, then query by the parent's id, and record that with a lint-conventions-allow comment (docs/decisions/tenant-isolation.md)",
    // Only meaningful where `db` is a ScopedDb. In a route that still resolves
    // its own client, `unwrapped-route` is already the finding, and flagging
    // the same line twice would just inflate the baseline.
    //
    // This is deliberately a "justify it" rule rather than a "never do it" one:
    // querying a child table is correct and unavoidable, and whether it is safe
    // depends on where the filter value came from — which no regex can see. So
    // the rule asks for the reason to be written down, exactly as
    // `db.unscoped(reason)` does, and makes every such site greppable.
    applies: (path, source) =>
      /\b(?:withTenant|withPublicRoute|withCron|createScopedDb)\b/.test(source),
    find: (source) =>
      matchAll(
        source,
        new RegExp(String.raw`\bdb\.from\(\s*["'](${CHILD_TABLES.join("|")})["']`, "g")
      ),
  },
  {
    id: "deep-feature-import",
    message:
      "deep import into another feature — import through its index.ts barrel (docs/decisions/feature-folders.md)",
    applies: () => true,
    find: (source, path) => {
      const own = path.match(/src\/features\/([^/]+)\//)?.[1];
      return matchAll(source, /@\/features\/([a-z0-9-]+)\/[^"'`]+/g).filter(
        (m) => m.groups?.[1] !== own
      );
    },
  },
];

function matchAll(source, pattern) {
  const out = [];
  pattern.lastIndex = 0;
  let m;
  while ((m = pattern.exec(source)) !== null) {
    out.push({ index: m.index, text: m[0].split("\n")[0].trim().slice(0, 80), groups: m });
    if (m[0].length === 0) pattern.lastIndex++;
  }
  return out;
}

function isClientComponent(path, source) {
  if (path.includes("/api/")) return false;
  if (path.includes("/lib/")) return false;
  return /^\s*["']use client["']/m.test(source);
}

// ─── Whole-codebase check: unenforced permissions ───────────────────────────
//
// `ECO_APPROVE` was defined in PERMISSIONS, described in PERMISSION_INFO,
// granted to Admin and Manager in DEFAULT_ROLES, and asserted in
// permissions.test.ts — and read by nothing. It looked enforced from every
// angle a reader would check. What made it matter rather than merely untidy:
// `findWorkflowForTrigger` falls through to a direct status update when no
// workflow is assigned, and no tenant is seeded with an ECO workflow. So one
// Engineer could take an ECO DRAFT → APPROVED alone and implement it, which
// releases parts, freezes files, and releases the BOM revisions it carries.
//
// A permission the server never reads is worse than no permission: the roles
// screen offers it, an admin grants it believing it does something, and the
// gate they think they configured is not there.
//
// This cannot be a per-file rule — the declaration and its enforcement are
// never in the same file — so it runs once over the whole scan and reports
// against the declaration line in permissions.ts.

const PERMISSIONS_FILE = "src/lib/permissions.ts";

/**
 * Where a permission may be enforced. Deliberately narrow, and the narrowness
 * is the interesting part: **a server component is server-side.** Classifying
 * by directory alone reported `audit.view` as unenforced the first time this
 * scan was run, because its gate is a check inside `admin/audit/page.tsx` that
 * runs before any query, with no endpoint to bypass. That was a false positive
 * on a permission that is genuinely enforced.
 *
 * Client components are excluded on purpose. `usePermissions().can(...)` hides
 * buttons, which is a UX affordance and not a control — a permission enforced
 * *only* there is exactly the hole this rule exists to find.
 */
function isEnforcementSite(path, source) {
  if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) return false;
  if (path === PERMISSIONS_FILE) return false; // declaration, not enforcement
  if (path.startsWith("src/app/api/")) return true;
  if (path.startsWith("src/lib/")) return true;
  if (path === "src/proxy.ts" || path === "src/middleware.ts") return true;
  // Server components: a page or layout with no "use client" directive.
  if (/\/(page|layout)\.tsx$/.test(path)) return !/^\s*["']use client["']/m.test(source);
  return false;
}

/** Parse `PERMISSIONS` from permissions.ts into [{ constName, value, line }]. */
function declaredPermissions() {
  const source = readFileSync(join(ROOT, ...PERMISSIONS_FILE.split("/")), "utf8");
  const block = source.match(/export const PERMISSIONS = \{([\s\S]*?)\n\} as const;/);
  if (!block) {
    console.error(
      `lint:conventions — could not read PERMISSIONS from ${PERMISSIONS_FILE}.\n` +
        "The unenforced-permission rule cannot run. Fix the parser rather than removing the rule."
    );
    process.exit(1);
  }
  const startLine = source.slice(0, block.index).split("\n").length;
  const out = [];
  block[1].split("\n").forEach((text, i) => {
    const m = text.match(/^\s*([A-Z0-9_]+):\s*["']([^"']+)["']/);
    if (m) out.push({ constName: m[1], value: m[2], line: startLine + i + 1 });
  });
  return out;
}

/**
 * A permission counts as enforced if a server-side file names it — either
 * through the constant (`PERMISSIONS.ECO_APPROVE`, the normal form) or as its
 * bare string value, which is how a few older hand-rolled checks read.
 */
function findUnenforcedPermissions(enforcementSources) {
  const rawLines = readFileSync(join(ROOT, ...PERMISSIONS_FILE.split("/")), "utf8").split("\n");
  const violations = [];

  for (const { constName, value, line } of declaredPermissions()) {
    const byConst = new RegExp(String.raw`\bPERMISSIONS\.${constName}\b`);
    const byValue = new RegExp(String.raw`["']${value.replace(/\./g, "\\.")}["']`);
    const enforced = enforcementSources.some((s) => byConst.test(s) || byValue.test(s));
    if (enforced) continue;
    if (isSuppressed(rawLines, line, "unenforced-permission")) continue;
    violations.push({
      file: PERMISSIONS_FILE,
      line,
      rule: "unenforced-permission",
      text: `${constName}: "${value}"`,
      message:
        "permission is granted and described but never read server-side — the roles screen " +
        "offers a gate that does not exist. Enforce it in a route or server component, or " +
        "remove it (docs/plans/functional-audit.md finding 2)",
    });
  }
  return violations;
}

// ─── Scan ───────────────────────────────────────────────────────────────────

const violations = [];
/** Comment-stripped sources of every file where a permission may be enforced. */
const enforcementSources = [];

for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const relPath = relative(ROOT, file).split(sep).join("/");
    const raw = readFileSync(file, "utf8");
    const rawLines = raw.split("\n");
    const source = stripComments(raw);

    if (isEnforcementSite(relPath, raw)) enforcementSources.push(source);

    for (const rule of RULES) {
      if (!rule.applies(relPath, raw)) continue;
      for (const match of rule.find(source, relPath)) {
        const line = lineOf(source, match.index);
        if (isSuppressed(rawLines, line, rule.id)) continue;
        violations.push({
          file: relPath,
          line,
          rule: rule.id,
          text: match.text,
          message: rule.message,
        });
      }
    }
  }
}

// Runs after the per-file scan because it needs every enforcement site at once.
violations.push(...findUnenforcedPermissions(enforcementSources));

if (process.argv.includes("--update")) {
  writeBaseline(BASELINE_PATH, violations);
  process.exit(0);
}

if (process.argv.includes("--list")) {
  const rule = process.argv[process.argv.indexOf("--list") + 1];
  for (const v of violations) {
    if (!rule || v.rule === rule) console.log(`${v.file}:${v.line}\t${v.rule}\t${v.text}`);
  }
  process.exit(0);
}

const result = compare(violations, loadBaseline(BASELINE_PATH));
process.exit(report("lint:conventions", result, "scripts/conventions.baseline.json"));
