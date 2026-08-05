// Part packages — the unit sourcing actually sends a supplier.
//
// A release is scoped to an ECO ("what change 014 shipped"). A supplier
// does not think in ECOs; they ask for a part number and expect the
// drawing, the model and the spec that go with it. This module resolves
// that set.
//
// Two decisions worth knowing before you change anything here:
//
//   1. **The package is resolved at view time, not at mint time.** A
//      share link points at a part id, and the files are gathered on each
//      request. A supplier who bookmarks the link and returns after an
//      ECO ships sees the new revision. Freezing the set when the link is
//      created would reintroduce exactly the staleness this replaces —
//      which is also why this is not modelled as a release.
//
//   2. **Released files only, unless the link says otherwise.**
//      `part_files` links whatever is attached, including work in progress.
//      Sending a supplier a WIP drawing is the specific accident the
//      vault's lifecycle exists to prevent, so the package filters on it
//      and reports how many were withheld. The count is surfaced to the
//      *internal* user in the share dialog and never to the guest — a
//      supplier has no business knowing that three other drawings exist.
//
//      `includeWip` opts a single link out. It exists because quoting
//      often has to happen before a formal release, and the honest answer
//      to that is a labelled preliminary package rather than a quietly
//      relaxed filter. Every file it lets through carries
//      `isPreliminary: true`, and every renderer is expected to say so —
//      the viewer stamps the row, the zip prefixes the filename. If you
//      add a third renderer, stamp it there too.
//
// Contrast with releases.ts, which reads a frozen jsonb manifest and
// never touches live tables. Opposite choice, opposite reason: a release
// is history and must not move; a part package is "what is current" and
// must.

import type { SupabaseClient } from "@supabase/supabase-js";
import { Zip, ZipPassThrough } from "fflate";

/** Lifecycle states whose files are safe to put in front of a supplier. */
const SHAREABLE_STATES = ["Released"];

export interface PartPackageFile {
  fileId: string;
  fileName: string;
  fileType: string;
  role: string;
  isPrimary: boolean;
  version: number;
  revision: string;
  storageKey: string;
  /** Not in a released state. Only ever true when the link set `includeWip`. */
  isPreliminary: boolean;
  lifecycleState: string;
}

export interface PartPackageBom {
  bomId: string;
  name: string;
  revision: string | null;
  status: string | null;
}

export interface PartPackage {
  partId: string;
  partNumber: string;
  name: string;
  description: string | null;
  revision: string;
  lifecycleState: string;
  category: string | null;
  material: string | null;
  unit: string | null;
  weight: number | null;
  weightUnit: string | null;
  files: PartPackageFile[];
  boms: PartPackageBom[];
  /**
   * How many linked files were left out because they are not released.
   * Always 0 when `includeWip` was set. For the internal share dialog only
   * — never send this to a guest.
   */
  filesWithheld: number;
  /** True when this package was built with the WIP opt-in. */
  includesWip: boolean;
  /** How many of `files` are preliminary. 0 unless `includeWip`. */
  preliminaryCount: number;
}

export interface BuildPartPackageOptions {
  /**
   * Include files that are not in a released state, flagged
   * `isPreliminary`. Off by default, and it must stay that way: this is
   * the difference between a supplier quoting from an approved drawing and
   * quoting from someone's work in progress.
   */
  includeWip?: boolean;
}

/**
 * Resolve a part into the package a supplier should receive.
 *
 * Takes a raw client and scopes every query by the `tenantId` it is
 * handed, in the same shape as `captureBomSnapshot` and `getFileWhereUsed`.
 * Callers inside a wrapped route pass `db.unscoped(reason)`.
 *
 * Returns null when the part does not exist, is deleted, or belongs to
 * another tenant — callers map that to a 404 without distinguishing,
 * so a guessed id cannot confirm a part's existence.
 */
export async function buildPartPackage(
  db: SupabaseClient,
  tenantId: string,
  partId: string,
  options: BuildPartPackageOptions = {}
): Promise<PartPackage | null> {
  const includeWip = options.includeWip === true;
  const { data: part } = await db
    .from("parts")
    .select(
      "id, partNumber, name, description, revision, lifecycleState, category, material, unit, weight, weightUnit"
    )
    .eq("id", partId)
    .eq("tenantId", tenantId)
    .is("deletedAt", null)
    .maybeSingle();
  if (!part) return null;

  // Linked files. `part_files` has no tenantId of its own — it is reached
  // through the part, which was just resolved under the tenant filter.
  const { data: linkRows } = await db
    .from("part_files")
    .select(
      `role, isPrimary,
       file:files!part_files_fileId_fkey(id, name, fileType, currentVersion, revision, lifecycleState, tenantId, deletedAt)`
    )
    .eq("partId", partId);

  type LinkedFile = {
    id: string;
    name: string;
    fileType: string | null;
    currentVersion: number;
    revision: string | null;
    lifecycleState: string | null;
    tenantId: string;
    deletedAt: string | null;
  };

  const files: PartPackageFile[] = [];
  let filesWithheld = 0;

  for (const row of linkRows ?? []) {
    const file = row.file as unknown as LinkedFile | null;
    if (!file || file.deletedAt) continue;
    // Defence in depth: part_files is joined, not tenant-filtered, so a
    // corrupted link row must not become a cross-tenant read.
    if (file.tenantId !== tenantId) continue;

    const released = SHAREABLE_STATES.includes(file.lifecycleState ?? "");
    if (!released && !includeWip) {
      filesWithheld++;
      continue;
    }

    const { data: version } = await db
      .from("file_versions")
      .select("version, storageKey")
      .eq("fileId", file.id)
      .eq("version", file.currentVersion)
      .maybeSingle();
    // A file whose current version row is missing is a broken record, not
    // a withheld one. Skip it rather than reporting it as suppressed.
    if (!version) continue;

    files.push({
      fileId: file.id,
      fileName: file.name,
      fileType: file.fileType ?? "",
      role: (row.role as string) ?? "OTHER",
      isPrimary: !!row.isPrimary,
      version: version.version as number,
      revision: file.revision ?? "",
      storageKey: version.storageKey as string,
      isPreliminary: !released,
      lifecycleState: file.lifecycleState ?? "",
    });
  }

  // Released before preliminary, then primary, then role, then name. The
  // released ordering comes first deliberately: if a supplier reads only
  // the top of the list, it should be the approved work.
  files.sort((a, b) => {
    if (a.isPreliminary !== b.isPreliminary) return a.isPreliminary ? 1 : -1;
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    if (a.role !== b.role) return a.role.localeCompare(b.role);
    return a.fileName.localeCompare(b.fileName);
  });

  // BOMs this part heads. Released revisions only, and superseded ones
  // excluded — the same "is this current" predicate the BOM list uses.
  const { data: bomRows } = await db
    .from("boms")
    .select("id, name, revision, status")
    .eq("partId", partId)
    .eq("tenantId", tenantId)
    .eq("status", "RELEASED")
    .is("supersededById", null)
    .is("deletedAt", null);

  const boms: PartPackageBom[] = (bomRows ?? []).map((b) => ({
    bomId: b.id as string,
    name: (b.name as string) ?? "",
    revision: (b.revision as string | null) ?? null,
    status: (b.status as string | null) ?? null,
  }));

  return {
    partId: part.id as string,
    partNumber: (part.partNumber as string) ?? "",
    name: (part.name as string) ?? "",
    description: (part.description as string | null) ?? null,
    revision: (part.revision as string) ?? "",
    lifecycleState: (part.lifecycleState as string) ?? "",
    category: (part.category as string | null) ?? null,
    material: (part.material as string | null) ?? null,
    unit: (part.unit as string | null) ?? null,
    weight: (part.weight as number | null) ?? null,
    weightUnit: (part.weightUnit as string | null) ?? null,
    files,
    boms,
    filesWithheld,
    includesWip: includeWip,
    preliminaryCount: files.filter((f) => f.isPreliminary).length,
  };
}

/**
 * Stream the package as a zip: every released file plus a manifest.json.
 *
 * Same streaming shape as `buildReleaseZipStream` — fflate's Zip with one
 * ZipPassThrough per entry, so memory stays bounded no matter how large
 * the models are. A file whose signed URL cannot be issued is skipped
 * rather than failing the whole download; the manifest still lists it, so
 * the recipient can tell something is missing and ask.
 */
export function buildPartZipStream(
  pkg: PartPackage,
  db: SupabaseClient
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const zip = new Zip((err, data, final) => {
        if (err) {
          controller.error(err);
          return;
        }
        if (data && data.length > 0) controller.enqueue(data);
        if (final) controller.close();
      });

      try {
        const usedNames = new Set<string>();
        const claimName = (fileId: string, raw: string): string => {
          const cleaned = raw.replace(/[\\/]/g, "_").trim() || fileId;
          if (!usedNames.has(cleaned)) {
            usedNames.add(cleaned);
            return cleaned;
          }
          const alt = `${fileId}-${cleaned}`;
          usedNames.add(alt);
          return alt;
        };

        const included: string[] = [];
        const missing: string[] = [];

        for (const file of pkg.files) {
          const { data: signed, error: signErr } = await db.storage
            .from("vault")
            .createSignedUrl(file.storageKey, 300);
          if (signErr || !signed) {
            missing.push(file.fileName);
            continue;
          }
          const response = await fetch(signed.signedUrl);
          if (!response.ok || !response.body) {
            missing.push(file.fileName);
            continue;
          }

          // A preliminary file gets the warning in its *filename*. Once the
          // zip is extracted onto someone else's desktop the filename is the
          // only context that survives — the manifest gets ignored, the web
          // page is long closed, and the drawing gets emailed onward on its
          // own. This is the one label that travels with the file.
          const entryName = file.isPreliminary ? `PRELIMINARY-${file.fileName}` : file.fileName;

          const entry = new ZipPassThrough(claimName(file.fileId, entryName));
          zip.add(entry);
          included.push(file.fileName);

          const reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              entry.push(new Uint8Array(0), true);
              break;
            }
            if (value && value.length > 0) entry.push(value, false);
          }
        }

        // A plain-text warning for anyone who will never open manifest.json,
        // which is most people. Only written when it applies.
        if (pkg.preliminaryCount > 0) {
          const readme = new ZipPassThrough("READ-ME-FIRST.txt");
          zip.add(readme);
          const lines = [
            `${pkg.partNumber} rev ${pkg.revision} — ${pkg.name}`,
            "",
            "THIS PACKAGE CONTAINS PRELIMINARY DOCUMENTS.",
            "",
            `${pkg.preliminaryCount} of ${pkg.files.length} document(s) in this archive have NOT been`,
            "released. Their filenames are prefixed PRELIMINARY-.",
            "",
            "Preliminary documents are provided for quotation and planning only.",
            "They are subject to change and MUST NOT be used for production,",
            "tooling, or final inspection. Request a released package before",
            "committing to manufacture.",
            "",
            "Released documents in this archive carry no prefix and may be used",
            "normally.",
            "",
            `Generated ${new Date().toISOString()} by PACE PDM.`,
            "",
          ];
          readme.push(new TextEncoder().encode(lines.join("\r\n")), true);
        }

        // The manifest is what makes the zip self-describing once it has
        // been extracted onto someone else's desktop and renamed.
        // `filesWithheld` is deliberately absent — see the module header.
        const manifestEntry = new ZipPassThrough("manifest.json");
        zip.add(manifestEntry);
        const manifestJson = JSON.stringify(
          {
            partNumber: pkg.partNumber,
            name: pkg.name,
            revision: pkg.revision,
            description: pkg.description,
            lifecycleState: pkg.lifecycleState,
            category: pkg.category,
            material: pkg.material,
            unit: pkg.unit,
            weight: pkg.weight,
            weightUnit: pkg.weightUnit,
            generatedAt: new Date().toISOString(),
            containsPreliminary: pkg.preliminaryCount > 0,
            files: pkg.files.map((f) => ({
              fileName: f.isPreliminary ? `PRELIMINARY-${f.fileName}` : f.fileName,
              fileType: f.fileType,
              role: f.role,
              isPrimary: f.isPrimary,
              revision: f.revision,
              version: f.version,
              preliminary: f.isPreliminary,
              included: included.includes(f.fileName),
            })),
            boms: pkg.boms,
            ...(missing.length > 0 ? { unavailable: missing } : {}),
          },
          null,
          2
        );
        manifestEntry.push(new TextEncoder().encode(manifestJson), true);

        zip.end();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/**
 * Filename for the downloaded zip: part number and revision, which is how
 * the recipient will file it. Filesystem-safe on Windows, macOS and Linux.
 */
export function partZipFilename(pkg: PartPackage): string {
  const safe = `${pkg.partNumber}-${pkg.revision}`.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return `${safe}.zip`;
}
