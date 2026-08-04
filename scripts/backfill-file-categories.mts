#!/usr/bin/env node
/**
 * Re-derive `files.category` from the file extension where the stored value
 * cannot be right.
 *
 * Two ways files ended up mislabelled:
 *
 *   1. Uploaded before migration-025 added DRAWING_2D / MODEL_3D to the enum,
 *      so they fell back to OTHER. (`Post Cylinder Spacer.STEP` → OTHER.)
 *   2. Someone picked a category by hand in the upload dialog, which overrode
 *      the correct extension-derived value. (A `.SLDDRW` drawing sheet → MODEL_3D.)
 *
 * Deliberately conservative. It only rewrites rows where the stored category is
 * either `OTHER` (an unambiguous fallback, never a considered choice) or is
 * impossible for the extension per `isCategoryPlausible` — a drawing sheet
 * stored as a 3D model, or vice versa. Everything else is left alone, because
 * a `.pdf` marked DRAWING rather than DOCUMENT is a judgement call that belongs
 * to whoever uploaded it.
 *
 * Dry run by default. Pass --apply to write.
 *
 *   npm run backfill:categories            # show what would change
 *   npm run backfill:categories -- --apply # do it
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  categoryForFilename,
  isCategoryPlausible,
  CATEGORY_LABELS,
} from "../src/lib/file-categories";

for (const file of [".env.local", ".env"]) {
  const path = join(process.cwd(), file);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const APPLY = process.argv.includes("--apply");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const { data: files, error } = await db
  .from("files")
  .select("id, name, fileType, category, tenantId, deletedAt");

if (error) {
  console.error("Could not read files:", error.message);
  process.exit(1);
}

const changes: Array<{
  id: string;
  name: string;
  from: string | null;
  to: string;
  reason: string;
  deleted: boolean;
}> = [];
for (const f of files) {
  const derived = categoryForFilename(f.name);
  if (derived === "OTHER") continue; // no opinion about this extension
  if (derived === f.category) continue; // already right

  // Only correct an unambiguous fallback or an impossible combination.
  const isFallback = f.category === "OTHER" || f.category === null;
  const isImpossible = !isCategoryPlausible(f.name, f.category);
  if (!isFallback && !isImpossible) continue;

  changes.push({
    id: f.id,
    name: f.name,
    from: f.category,
    to: derived,
    reason: isFallback ? "fallback OTHER" : "impossible for extension",
    deleted: !!f.deletedAt,
  });
}

console.log(`${files.length} file(s) scanned, ${changes.length} to correct\n`);

for (const c of changes) {
  const label = (v: string | null) =>
    (v ? CATEGORY_LABELS[v as keyof typeof CATEGORY_LABELS] : null) ?? v ?? "(null)";
  console.log(`${c.deleted ? "[deleted] " : ""}${c.name}`);
  console.log(`    ${label(c.from)} → ${label(c.to)}   (${c.reason})`);
}

if (changes.length === 0) {
  console.log("Nothing to do.");
  process.exit(0);
}

if (!APPLY) {
  console.log(`\nDry run. Re-run with --apply to write these ${changes.length} change(s).`);
  process.exit(0);
}

let applied = 0;
for (const c of changes) {
  const { error: updateError } = await db
    .from("files")
    .update({ category: c.to, updatedAt: new Date().toISOString() })
    .eq("id", c.id);
  if (updateError) {
    console.error(`  FAILED ${c.name}: ${updateError.message}`);
    continue;
  }
  applied += 1;
}

console.log(`\nApplied ${applied} of ${changes.length} change(s).`);
