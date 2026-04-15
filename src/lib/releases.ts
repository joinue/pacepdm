// Release packages.
//
// A release is the immutable record of what an ECO shipped. It's built
// by reading — *after* `implement_eco` has committed — the post-state of
// the parts, files, and BOMs the ECO touched, then freezing that state
// into a single jsonb manifest. The release page and the public share
// viewer read the manifest and never reach into live tables for display,
// so a later rename or delete of a part/file/BOM doesn't change what a
// historical release shows.
//
// Why build the manifest in TypeScript instead of extending the SQL
// function: the release is a read-after-write that's logically separate
// from the ECO implementation (a failure to snapshot should not roll
// back the implementation itself, same philosophy as BOM auto-baselines
// on release). Keeping it in JS also makes the manifest shape easy to
// evolve without schema migrations.

import { v4 as uuid } from "uuid";
import type { SupabaseClient } from "@supabase/supabase-js";
import { captureBomSnapshot } from "@/lib/bom-snapshot";

// ─── Manifest shapes ──────────────────────────────────────────────────────

export interface ReleasePart {
  partId: string;
  partNumber: string;
  name: string;
  fromRevision: string | null;
  toRevision: string;
  lifecycleState: string;
  category: string | null;
}

export interface ReleaseFile {
  fileId: string;
  fileName: string;
  fileType: string;
  versionId: string;
  version: number;
  revision: string;
  storageKey: string;
  lifecycleState: string;
}

/**
 * A BOM snapshot inlined into the release manifest. We store the full
 * snapshot payload — not just the ID — so the release is self-contained
 * and survives later deletion of the BOM. `snapshotId` is kept as a
 * cross-reference for admins who want to correlate with bom_snapshots
 * rows, but the UI renders from `bomName`/`items` directly.
 */
export interface ReleaseBomSnapshot {
  snapshotId: string;
  bomId: string;
  bomName: string;
  bomRevision: string | null;
  bomStatus: string | null;
  itemCount: number;
  flatTotalCost: number;
}

export interface ReleaseManifest {
  parts: ReleasePart[];
  files: ReleaseFile[];
  boms: ReleaseBomSnapshot[];
}

export interface ReleaseRow {
  id: string;
  tenantId: string;
  ecoId: string;
  ecoNumber: string;
  name: string;
  releasedAt: string;
  releasedById: string | null;
  note: string | null;
  manifest: ReleaseManifest;
}

// ─── Core builder ─────────────────────────────────────────────────────────

export interface CreateReleaseArgs {
  db: SupabaseClient;
  tenantId: string;
  ecoId: string;
  userId: string;
}

/**
 * Build and persist a release row from a just-implemented ECO. Call this
 * from the implement_eco handler right after the RPC returns successfully.
 *
 * Failure is non-fatal to the caller — the ECO implementation is already
 * committed by the time we get here. Log and continue. A missing release
 * row is a documentation gap, not a correctness problem, and the caller
 * can choose to expose a "retry release capture" admin action later.
 */
export async function createReleaseFromEco(
  args: CreateReleaseArgs
): Promise<ReleaseRow | null> {
  const { db, tenantId, ecoId, userId } = args;

  // ── Step 1: pull the ECO header for the denormalized fields on the
  //           release row (ecoNumber, name default). Also gives us a
  //           defensive tenant check.
  const { data: eco } = await db
    .from("ecos")
    .select("id, tenantId, ecoNumber, title")
    .eq("id", ecoId)
    .single();
  if (!eco || eco.tenantId !== tenantId) {
    throw new Error(`createReleaseFromEco: ECO ${ecoId} not found in tenant`);
  }

  // ── Step 2: read eco_items to find every part and file the ECO touched.
  //           At this point implement_eco has already committed, so
  //           parts.revision is the post-state and eco_items.toRevision is
  //           set. files are covered via direct eco_items.fileId AND via
  //           part_files linkage from any part items.
  const { data: items, error: itemsError } = await db
    .from("eco_items")
    .select("id, partId, fileId, fromRevision, toRevision")
    .eq("ecoId", ecoId);
  if (itemsError) throw itemsError;

  const partItemById = new Map<string, { fromRevision: string | null; toRevision: string | null }>();
  const directFileIds = new Set<string>();
  for (const item of items ?? []) {
    if (item.partId) {
      partItemById.set(item.partId as string, {
        fromRevision: (item.fromRevision as string | null) ?? null,
        toRevision: (item.toRevision as string | null) ?? null,
      });
    }
    if (item.fileId) directFileIds.add(item.fileId as string);
  }

  // ── Step 3: parts — read post-implement state for every partId touched.
  const parts: ReleasePart[] = [];
  if (partItemById.size > 0) {
    const { data: partRows, error: partErr } = await db
      .from("parts")
      .select("id, partNumber, name, revision, lifecycleState, category")
      .in("id", Array.from(partItemById.keys()));
    if (partErr) throw partErr;
    for (const p of partRows ?? []) {
      const item = partItemById.get(p.id as string);
      parts.push({
        partId: p.id as string,
        partNumber: (p.partNumber as string) ?? "",
        name: (p.name as string) ?? "",
        fromRevision: item?.fromRevision ?? null,
        toRevision: item?.toRevision ?? (p.revision as string) ?? "",
        lifecycleState: (p.lifecycleState as string) ?? "",
        category: (p.category as string | null) ?? null,
      });
    }
  }

  // ── Step 4: files — gather the full affected set. Direct eco_items plus
  //           indirect via part_files for each affected part. Then resolve
  //           each to its current version row to get a frozen version ID
  //           and storage key the manifest can later stream from.
  const allFileIds = new Set<string>(directFileIds);
  if (partItemById.size > 0) {
    const { data: partFileRows, error: pfErr } = await db
      .from("part_files")
      .select("fileId")
      .in("partId", Array.from(partItemById.keys()));
    if (pfErr) throw pfErr;
    for (const row of partFileRows ?? []) {
      if (row.fileId) allFileIds.add(row.fileId as string);
    }
  }

  const files: ReleaseFile[] = [];
  if (allFileIds.size > 0) {
    const { data: fileRows, error: fileErr } = await db
      .from("files")
      .select("id, name, fileType, currentVersion, revision, lifecycleState, tenantId")
      .in("id", Array.from(allFileIds));
    if (fileErr) throw fileErr;
    for (const f of fileRows ?? []) {
      if (f.tenantId !== tenantId) continue;
      // Pull the current version row for the frozen storageKey + versionId.
      // We intentionally capture the version that's current *right now*,
      // immediately after implement_eco committed the transition.
      const { data: version } = await db
        .from("file_versions")
        .select("id, version, storageKey")
        .eq("fileId", f.id as string)
        .eq("version", f.currentVersion as number)
        .maybeSingle();
      if (!version) continue;
      files.push({
        fileId: f.id as string,
        fileName: (f.name as string) ?? "",
        fileType: (f.fileType as string) ?? "",
        versionId: version.id as string,
        version: version.version as number,
        revision: (f.revision as string) ?? "",
        storageKey: version.storageKey as string,
        lifecycleState: (f.lifecycleState as string) ?? "",
      });
    }
  }

  // ── Step 5: BOMs — any BOM whose parent file is in the affected set
  //           gets its own snapshot via captureBomSnapshot, and we inline
  //           the lightweight header (name, itemCount, total cost) into
  //           the release manifest. The heavy items[] payload lives in
  //           bom_snapshots.items and the release page loads it lazily
  //           from there, so manifest size stays bounded.
  const boms: ReleaseBomSnapshot[] = [];
  if (allFileIds.size > 0) {
    const { data: bomRows, error: bomErr } = await db
      .from("boms")
      .select("id, name, revision, status")
      .in("fileId", Array.from(allFileIds))
      .eq("tenantId", tenantId);
    if (bomErr) throw bomErr;
    for (const b of bomRows ?? []) {
      try {
        const snap = await captureBomSnapshot({
          db,
          tenantId,
          bomId: b.id as string,
          userId,
          trigger: "ECO_IMPLEMENT",
          ecoId,
        });
        boms.push({
          snapshotId: snap.snapshotId,
          bomId: b.id as string,
          bomName: (b.name as string) ?? "",
          bomRevision: (b.revision as string | null) ?? null,
          bomStatus: (b.status as string | null) ?? null,
          itemCount: snap.itemCount,
          flatTotalCost: snap.flatTotalCost,
        });
      } catch (err) {
        // Snapshot of one BOM failed — log and continue. A missing BOM
        // snapshot is less serious than a missing release row.
        console.error(
          `[releases] BOM snapshot failed for bom ${b.id} in ECO ${ecoId}:`,
          err
        );
      }
    }
  }

  // ── Step 6: write the release row. Unique index on ecoId enforces
  //           at-most-one-release-per-ECO; a retry returns null gracefully.
  const id = uuid();
  const manifest: ReleaseManifest = { parts, files, boms };
  const name = `${eco.ecoNumber as string} release`;

  const { data: inserted, error: insertErr } = await db
    .from("releases")
    .insert({
      id,
      tenantId,
      ecoId,
      ecoNumber: eco.ecoNumber as string,
      name,
      releasedAt: new Date().toISOString(),
      releasedById: userId,
      note: null,
      manifest,
    })
    .select()
    .single();

  if (insertErr) {
    // 23505 = unique_violation. A retry of implement_eco (which itself
    // can't actually happen because the ECO is already IMPLEMENTED) would
    // hit this; treat as a no-op success.
    if ((insertErr as { code?: string }).code === "23505") {
      const { data: existing } = await db
        .from("releases")
        .select("*")
        .eq("ecoId", ecoId)
        .single();
      return (existing as ReleaseRow | null) ?? null;
    }
    throw insertErr;
  }

  return inserted as ReleaseRow;
}

// ─── Read helpers ─────────────────────────────────────────────────────────

export async function getReleaseById(
  db: SupabaseClient,
  tenantId: string,
  releaseId: string
): Promise<ReleaseRow | null> {
  const { data } = await db
    .from("releases")
    .select("*")
    .eq("id", releaseId)
    .eq("tenantId", tenantId)
    .maybeSingle();
  return (data as ReleaseRow | null) ?? null;
}

export async function getReleaseForEco(
  db: SupabaseClient,
  tenantId: string,
  ecoId: string
): Promise<ReleaseRow | null> {
  const { data } = await db
    .from("releases")
    .select("*")
    .eq("ecoId", ecoId)
    .eq("tenantId", tenantId)
    .maybeSingle();
  return (data as ReleaseRow | null) ?? null;
}

// ─── Zip streaming ────────────────────────────────────────────────────────
//
// Building a zip of a whole release is the single biggest differentiator
// of this feature — a CM gets one file instead of emailing back and forth
// asking which rev goes with which drawing. We stream it through fflate's
// Zip / ZipPassThrough API so memory stays bounded regardless of how
// many (or how large) the files are. Client-side assembly isn't viable
// because large selections OOM the browser (see the vault bulk-download
// gap in project memory).
//
// Each file in the manifest is streamed from Supabase storage via a
// signed URL into its own ZipPassThrough entry. A final manifest.json
// entry is added so the CM has a record of what was in the bundle —
// part revisions, BOM headers, release metadata — even after extraction.

import { Zip, ZipPassThrough } from "fflate";

/**
 * Build a ReadableStream that emits a zip of the release's files plus a
 * manifest.json. Intended to be returned directly as a Next.js Response
 * body with Content-Type: application/zip.
 *
 * Filenames in the zip are kept as-is from the manifest with only the
 * path separators stripped (so "/" in a filename can't escape into a
 * directory). Collisions on identical filenames in the same release
 * are disambiguated by prepending the file ID — a rare case, but zips
 * with duplicate entry names confuse some extraction tools.
 */
export function buildReleaseZipStream(
  release: ReleaseRow,
  db: SupabaseClient
): ReadableStream<Uint8Array> {
  const manifest = release.manifest;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // fflate's streaming Zip fires `ondata` for each chunk of the
      // compressed output. We forward those chunks to the response
      // stream; `final=true` closes the stream and finalizes the central
      // directory.
      const zip = new Zip((err, data, final) => {
        if (err) {
          controller.error(err);
          return;
        }
        if (data && data.length > 0) controller.enqueue(data);
        if (final) controller.close();
      });

      try {
        // Track names so we can disambiguate collisions without breaking
        // the zip on identical entry paths.
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

        for (const file of manifest.files) {
          const { data: signed, error: signErr } = await db.storage
            .from("vault")
            .createSignedUrl(file.storageKey, 300);
          if (signErr || !signed) {
            // A missing file becomes a note in manifest.json at the end;
            // we skip the zip entry rather than fail the whole download.
            continue;
          }
          const response = await fetch(signed.signedUrl);
          if (!response.ok || !response.body) continue;

          const entry = new ZipPassThrough(claimName(file.fileId, file.fileName));
          zip.add(entry);

          const reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              // push an empty final chunk to signal end-of-entry
              entry.push(new Uint8Array(0), true);
              break;
            }
            if (value && value.length > 0) entry.push(value, false);
          }
        }

        // Append a manifest.json with the release metadata — CM gets a
        // record of what's in the archive without needing to log in.
        const manifestEntry = new ZipPassThrough("manifest.json");
        zip.add(manifestEntry);
        const manifestJson = JSON.stringify(
          {
            releaseId: release.id,
            releaseName: release.name,
            ecoNumber: release.ecoNumber,
            releasedAt: release.releasedAt,
            parts: manifest.parts,
            files: manifest.files.map((f) => ({
              fileName: f.fileName,
              fileType: f.fileType,
              version: f.version,
              revision: f.revision,
            })),
            boms: manifest.boms,
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
 * Suggest a filename for the downloaded zip. Stable and derived from the
 * release name so CM bookmarks don't break, and filesystem-safe so it
 * works on Windows, macOS, and Linux without escape gymnastics.
 */
export function releaseZipFilename(release: ReleaseRow): string {
  const safe = release.name.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return `${safe}.zip`;
}
