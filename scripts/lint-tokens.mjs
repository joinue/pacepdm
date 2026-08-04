#!/usr/bin/env node
/**
 * Design-token discipline gate (AGENTS.md "Styling and tokens").
 *
 * Fails on three things in the rendering surface (src/app, src/components,
 * src/features):
 *
 *   1. Arbitrary px in a Tailwind utility — `text-[13px]`, `h-[72px]`.
 *      Use a token or the spacing scale. Non-px arbitrary values (`max-w-[42ch]`,
 *      `grid-cols-[auto_1fr]`) are fine: they have no scale to belong to.
 *
 *   2. Raw Tailwind palette classes — `text-gray-500`, `bg-red-100`.
 *      These do not respond to the theme, so every one of them is either
 *      already wrong in dark mode or accidentally right. Use a semantic token
 *      (`text-muted-foreground`, `bg-card`, `text-destructive`) or, for
 *      status colours, the shared StatusBadge.
 *
 *   3. Hardcoded hex colours in components.
 *
 * Comments and import paths are ignored — they document intent, they don't
 * render.
 *
 * A file may be exempted only for a reason a token genuinely cannot serve
 * (see ALLOW below). Adding to that list is a decision, not a default.
 *
 * See docs/decisions/design-tokens.md.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { loadBaseline, writeBaseline, compare, report } from "./lib/baseline.mjs";

const ROOT = process.cwd();
const BASELINE_PATH = join(ROOT, "scripts", "tokens.baseline.json");
const SCAN_DIRS = ["src/app", "src/components", "src/features"];
const EXTENSIONS = [".ts", ".tsx", ".css"];

/**
 * Files exempt from these rules, each for a reason a token cannot serve.
 * Adding a file here is a decision, not a default — if you reach for it for
 * ordinary UI, you want a token.
 */
const ALLOW = [
  // Where the tokens themselves are defined.
  "src/app/globals.css",
  // three.js materials take numeric colours, not CSS.
  "components/vault/cad-viewer.tsx",
  // pdfjs and @napi-rs/canvas draw with literal colours onto a bitmap.
  "lib/thumbnail.ts",

  // ── Colour as DATA, not theme ────────────────────────────────────────────
  // Lifecycle states carry a user-chosen colour persisted on the row. These
  // hex literals are the seeded defaults for a new tenant and the fallback for
  // a state with no colour set — values the customer owns and can change in
  // the UI, not part of the design system.
  "app/api/tenants/route.ts",
  "app/api/lifecycle/[lifecycleId]/states/route.ts",
  "app/(dashboard)/admin/lifecycle/page.tsx",

  // ── Vendor component recipes ─────────────────────────────────────────────
  // These are shadcn's own class recipes (`ring-[3px]` focus rings, `p-[3px]`
  // tab padding, `rounded-[2px]` tooltip arrows). Rewriting them means
  // diverging from upstream and re-doing the divergence on every component
  // update, to no visual benefit. The rule still applies to anything we
  // compose from them.
  "components/ui/badge.tsx",
  "components/ui/dropdown-menu.tsx",
  "components/ui/scroll-area.tsx",
  "components/ui/tabs.tsx",
  "components/ui/tooltip.tsx",
];

/** Tailwind's default palette families. A token never looks like these. */
const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";

/** Utilities that take a colour and therefore must take a token. */
const COLOR_UTILITIES =
  "bg|text|border|ring|fill|stroke|from|via|to|divide|outline|shadow|accent|caret|decoration|placeholder";

const RULES = [
  {
    id: "arbitrary-px",
    // A Tailwind utility with an arbitrary px value: `h-[72px]`, `text-[13px]`.
    pattern: /(?<![\w-])[a-z][a-z-]*-\[-?\d*\.?\d+px\]/g,
    message: "arbitrary px value — use a token or the spacing scale",
  },
  {
    id: "raw-palette",
    pattern: new RegExp(
      `(?<![\\w-])(?:${COLOR_UTILITIES})-(?:${PALETTE})-(?:50|\\d{3})(?![\\w-])`,
      "g"
    ),
    message: "raw palette class — use a semantic token (see docs/decisions/design-tokens.md)",
  },
  {
    id: "hex-color",
    pattern: /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?![0-9a-fA-F])/g,
    message: "hardcoded hex colour — use a token",
  },
];

/**
 * Blank out comments and string-literal import paths so their contents are not
 * scanned. Replacing with spaces preserves offsets, which keeps line numbers
 * and column positions honest.
 */
function stripNonRendering(source) {
  let out = source;
  const blank = (m) => " ".repeat(m.length);
  out = out.replace(/\/\*[\s\S]*?\*\//g, blank); // block comments
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
  out = out.replace(/^\s*import[^\n]*from\s*["'][^"']*["'];?/gm, blank);
  return out;
}

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

function isAllowed(relPath) {
  const normalized = relPath.split(sep).join("/");
  return ALLOW.some((allowed) => normalized.endsWith(allowed));
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

const violations = [];

for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const relPath = relative(ROOT, file);
    if (isAllowed(relPath)) continue;

    const raw = readFileSync(file, "utf8");
    const source = stripNonRendering(raw);

    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      let match;
      while ((match = rule.pattern.exec(source)) !== null) {
        violations.push({
          file: relPath.split(sep).join("/"),
          line: lineOf(source, match.index),
          rule: rule.id,
          text: match[0].trim(),
          message: rule.message,
        });
      }
    }
  }
}

if (process.argv.includes("--update")) {
  writeBaseline(BASELINE_PATH, violations);
  process.exit(0);
}

if (process.argv.includes("--list")) {
  for (const v of violations) {
    console.log(`${v.file}:${v.line}\t${v.rule}\t${v.text}`);
  }
  process.exit(0);
}

const result = compare(violations, loadBaseline(BASELINE_PATH));
process.exit(report("lint:tokens", result, "scripts/tokens.baseline.json"));
