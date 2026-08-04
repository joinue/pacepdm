/**
 * A ratchet for lint gates applied to a codebase that already has debt.
 *
 * The problem: a rule worth enforcing usually has hundreds of existing
 * violations, so turning it on red means everyone learns to ignore it, and
 * turning it on green means it never runs. Neither enforces anything.
 *
 * The ratchet takes a third option. It records the current violation count per
 * (file, rule) in a baseline file, then:
 *
 *   - a NEW violation, or one more in an already-dirty file, FAILS the build
 *   - fixing violations passes, and prints how far the count fell
 *   - the baseline can only be lowered, never raised, by `--update`
 *
 * So existing debt is visible and frozen, new debt is impossible, and cleanup
 * is a one-line diff to the baseline. The goal is an empty baseline file.
 *
 * Counts are keyed by (file, rule) rather than by line, so moving code around
 * does not churn the baseline.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

export function loadBaseline(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    console.error(`Could not parse ${path} — treating as empty.`);
    return {};
  }
}

/** Group violations into { [file]: { [rule]: count } }. */
export function tally(violations) {
  const counts = {};
  for (const v of violations) {
    counts[v.file] ??= {};
    counts[v.file][v.rule] = (counts[v.file][v.rule] || 0) + 1;
  }
  return counts;
}

export function writeBaseline(path, violations) {
  const counts = tally(violations);
  const sorted = {};
  for (const file of Object.keys(counts).sort()) {
    sorted[file] = Object.fromEntries(Object.entries(counts[file]).sort());
  }
  writeFileSync(path, JSON.stringify(sorted, null, 2) + "\n");
  const total = violations.length;
  console.log(
    `Baseline written to ${path} (${total} violation(s) across ${Object.keys(sorted).length} file(s)).`
  );
}

/**
 * Compare violations against the baseline.
 *
 * Returns { regressions, improvements, total, baselineTotal }. `regressions`
 * are the violations that exceed what the baseline allows, and are the only
 * ones that should fail a build.
 */
export function compare(violations, baseline) {
  const counts = tally(violations);
  const regressions = [];
  const improvements = [];

  for (const [file, rules] of Object.entries(counts)) {
    for (const [rule, count] of Object.entries(rules)) {
      const allowed = baseline[file]?.[rule] ?? 0;
      if (count > allowed) {
        // Report the newest offenders: everything beyond the allowance.
        const offenders = violations.filter((v) => v.file === file && v.rule === rule);
        regressions.push(...offenders.slice(allowed));
      } else if (count < allowed) {
        improvements.push({ file, rule, from: allowed, to: count });
      }
    }
  }

  // A file that was dirty and is now clean is also an improvement.
  for (const [file, rules] of Object.entries(baseline)) {
    for (const [rule, allowed] of Object.entries(rules)) {
      if (!counts[file]?.[rule]) {
        improvements.push({ file, rule, from: allowed, to: 0 });
      }
    }
  }

  const baselineTotal = Object.values(baseline).reduce(
    (sum, rules) => sum + Object.values(rules).reduce((a, b) => a + b, 0),
    0
  );

  return { regressions, improvements, total: violations.length, baselineTotal };
}

/**
 * Print the result and return the process exit code.
 */
export function report(name, { regressions, improvements, total }, baselinePath) {
  if (regressions.length > 0) {
    console.error(`\n${name} — ${regressions.length} new violation(s):\n`);
    for (const v of regressions) {
      console.error(`  ${v.file}:${v.line}  ${v.text}`);
      console.error(`      ${v.message}`);
    }
    console.error(
      `\nThese are new. Fix them — do not add them to the baseline.\n` +
        `The baseline in ${baselinePath} is frozen debt, not an allowlist for new code.\n`
    );
    return 1;
  }

  if (improvements.length > 0) {
    const fixed = improvements.reduce((sum, i) => sum + (i.from - i.to), 0);
    console.log(`${name} — clean, and ${fixed} baselined violation(s) fixed. Nice.`);
    console.log(
      `Run \`node ${process.argv[1].split(/[\\/]/).pop()} --update\` to lower the baseline.`
    );
    return 0;
  }

  if (total > 0) {
    console.log(`${name} — clean (${total} baselined violation(s) remaining, target is 0)`);
  } else {
    console.log(`${name} — clean`);
  }
  return 0;
}
