// Where-used / impact analysis.
//
// Given a part or a file, this module answers "what depends on this?" —
// the core PDM question before any revision. Both entity types produce a
// unified result shape so the UI can render them through one component.
//
// The non-trivial bit is `parentParts` for a part: the schema doesn't
// directly link a BOM to its "owning" assembly part. The convention used
// across the app is that an assembly BOM is attached to a file (via
// `boms.fileId`), and that same file is linked to the assembly part via
// `part_files`. So to walk up the tree we follow:
//
//   part.id → bom_items.partId → boms.fileId → part_files.fileId → parent part
//
// That chain is heuristic — a file linked to the BOM might be a drawing
// shared by multiple parts, or the BOM might have no file at all. The
// walker returns every candidate it finds and stops at MAX_DEPTH to
// bound worst-case work. Cycles are prevented by a visited set keyed
// on part id.

import type { SupabaseClient } from "@supabase/supabase-js";

/** Maximum depth for transitive parent-assembly walks. */
const MAX_DEPTH = 8;

export interface WhereUsedBom {
  bomId: string;
  bomName: string;
  bomRevision: string;
  bomStatus: string;
  quantity: number;
  unit: string;
}

export interface WhereUsedPart {
  partId: string;
  partNumber: string;
  name: string;
  revision: string;
  lifecycleState: string;
  category: string;
  /** Role from part_files (e.g., DRAWING, MODEL_3D). Only set on file→parts linkage. */
  role?: string;
  /** True when this is the primary file for the part. Only set on file→parts linkage. */
  isPrimary?: boolean;
  /** Depth from the source (1 = direct parent, 2 = grandparent, …). Only set on parent-assembly walks. */
  depth?: number;
}

export interface WhereUsedFile {
  fileId: string;
  name: string;
  fileType: string;
  category: string;
  revision: string;
  lifecycleState: string;
  role?: string;
  isPrimary?: boolean;
}

export interface WhereUsedEco {
  ecoId: string;
  ecoNumber: string;
  title: string;
  status: string;
  implementedAt: string | null;
  createdAt: string;
  /** Type of change recorded on the eco_item row (ADD / MODIFY / REMOVE / …). */
  changeType?: string | null;
  /** Only populated for parts — reflects the revision bump recorded by the ECO. */
  fromRevision?: string | null;
  toRevision?: string | null;
}

export interface PartWhereUsed {
  /** BOMs that list this part directly as a line item. */
  boms: WhereUsedBom[];
  /** Assembly parts that (transitively) contain this one via the BOM→file→part chain. */
  parentParts: WhereUsedPart[];
  /** Files attached to the part via part_files. */
  linkedFiles: WhereUsedFile[];
  /** ECOs that have touched this part via eco_items (most recent first). */
  ecos: WhereUsedEco[];
}

export interface FileWhereUsed {
  /** BOMs that reference this file as a line item. */
  boms: WhereUsedBom[];
  /** BOMs where this file IS the drawing (i.e. boms.fileId = fileId). */
  representsBoms: WhereUsedBom[];
  /** Parts that have this file attached via part_files. */
  linkedParts: WhereUsedPart[];
  /** ECOs that have touched this file via eco_items (most recent first). */
  ecos: WhereUsedEco[];
}

// Supabase's joined-row types are loose by design. The helpers below
// accept loose shapes and narrow them before returning — no `any` leaks
// out to callers.
type AnyRow = Record<string, unknown>;
type DbClient = SupabaseClient;

function sortEcosByRecency<T extends { implementedAt: string | null; createdAt: string }>(rows: T[]): T[] {
  // Most recent first. implementedAt wins when set (that's the real
  // "when did this affect production" timestamp); otherwise fall back to
  // the ECO's creation date so drafts still sort chronologically.
  return [...rows].sort((a, b) => {
    const at = a.implementedAt ?? a.createdAt;
    const bt = b.implementedAt ?? b.createdAt;
    return bt.localeCompare(at);
  });
}

/**
 * Resolve every where-used facet for a single part. All four queries
 * run in parallel; the recursive parent-assembly walk is sequential
 * by construction because each level depends on the previous.
 */
export async function getPartWhereUsed(
  db: DbClient,
  tenantId: string,
  partId: string
): Promise<PartWhereUsed> {
  const [bomsResult, filesResult, ecosResult] = await Promise.all([
    db
      .from("bom_items")
      .select("quantity, unit, bom:boms!bom_items_bomId_fkey(id, name, revision, status, tenantId)")
      .eq("partId", partId),
    db
      .from("part_files")
      .select("role, isPrimary, file:files!part_files_fileId_fkey(id, name, fileType, category, revision, lifecycleState, tenantId)")
      .eq("partId", partId),
    db
      .from("eco_items")
      .select("changeType, fromRevision, toRevision, eco:ecos!eco_items_ecoId_fkey(id, ecoNumber, title, status, implementedAt, createdAt, tenantId)")
      .eq("partId", partId),
  ]);

  const boms: WhereUsedBom[] = [];
  for (const row of (bomsResult.data ?? []) as AnyRow[]) {
    const bom = row.bom as { id: string; name: string; revision: string; status: string; tenantId: string } | null;
    if (!bom || bom.tenantId !== tenantId) continue;
    boms.push({
      bomId: bom.id,
      bomName: bom.name,
      bomRevision: bom.revision,
      bomStatus: bom.status,
      quantity: (row.quantity as number) ?? 0,
      unit: (row.unit as string) ?? "EA",
    });
  }

  const linkedFiles: WhereUsedFile[] = [];
  for (const row of (filesResult.data ?? []) as AnyRow[]) {
    const file = row.file as
      | {
          id: string;
          name: string;
          fileType: string;
          category: string;
          revision: string;
          lifecycleState: string;
          tenantId: string;
        }
      | null;
    if (!file || file.tenantId !== tenantId) continue;
    linkedFiles.push({
      fileId: file.id,
      name: file.name,
      fileType: file.fileType,
      category: file.category,
      revision: file.revision,
      lifecycleState: file.lifecycleState,
      role: (row.role as string) ?? undefined,
      isPrimary: (row.isPrimary as boolean) ?? undefined,
    });
  }

  const ecos: WhereUsedEco[] = [];
  for (const row of (ecosResult.data ?? []) as AnyRow[]) {
    const eco = row.eco as
      | {
          id: string;
          ecoNumber: string;
          title: string;
          status: string;
          implementedAt: string | null;
          createdAt: string;
          tenantId: string;
        }
      | null;
    if (!eco || eco.tenantId !== tenantId) continue;
    ecos.push({
      ecoId: eco.id,
      ecoNumber: eco.ecoNumber,
      title: eco.title,
      status: eco.status,
      implementedAt: eco.implementedAt,
      createdAt: eco.createdAt,
      changeType: (row.changeType as string | null) ?? null,
      fromRevision: (row.fromRevision as string | null) ?? null,
      toRevision: (row.toRevision as string | null) ?? null,
    });
  }

  const parentParts = await walkParentAssemblies(db, tenantId, partId);

  return {
    boms,
    parentParts,
    linkedFiles,
    ecos: sortEcosByRecency(ecos),
  };
}

/**
 * Breadth-first walk up the assembly tree. We expand one level at a
 * time so each database round-trip can batch-query all candidates for
 * that level, rather than firing one query per candidate.
 */
async function walkParentAssemblies(
  db: DbClient,
  tenantId: string,
  startPartId: string
): Promise<WhereUsedPart[]> {
  const visited = new Set<string>([startPartId]);
  const found: WhereUsedPart[] = [];
  let frontier = [startPartId];

  for (let depth = 1; depth <= MAX_DEPTH && frontier.length > 0; depth++) {
    // Step 1: for every part in the frontier, find BOMs that contain it.
    const { data: bomItems } = await db
      .from("bom_items")
      .select("partId, bomId")
      .in("partId", frontier);

    const bomIds = Array.from(
      new Set(
        (bomItems ?? [])
          .map((row) => (row as { bomId?: string }).bomId)
          .filter((id): id is string => typeof id === "string")
      )
    );
    if (bomIds.length === 0) break;

    // Step 2: fetch the files those BOMs are attached to.
    const { data: boms } = await db
      .from("boms")
      .select("id, fileId, tenantId")
      .in("id", bomIds);

    const fileIds = Array.from(
      new Set(
        (boms ?? [])
          .filter((b) => (b as { tenantId?: string }).tenantId === tenantId)
          .map((b) => (b as { fileId?: string | null }).fileId)
          .filter((id): id is string => typeof id === "string")
      )
    );
    if (fileIds.length === 0) break;

    // Step 3: resolve those files to their linked parts via part_files,
    // joining the parts row so we can return a proper display payload
    // without a second round-trip.
    const { data: links } = await db
      .from("part_files")
      .select("partId, part:parts!part_files_partId_fkey(id, partNumber, name, revision, lifecycleState, category, tenantId)")
      .in("fileId", fileIds);

    const nextFrontier: string[] = [];
    for (const row of (links ?? []) as AnyRow[]) {
      const part = row.part as
        | {
            id: string;
            partNumber: string;
            name: string;
            revision: string;
            lifecycleState: string;
            category: string;
            tenantId: string;
          }
        | null;
      if (!part || part.tenantId !== tenantId) continue;
      if (visited.has(part.id)) continue;
      visited.add(part.id);
      found.push({
        partId: part.id,
        partNumber: part.partNumber,
        name: part.name,
        revision: part.revision,
        lifecycleState: part.lifecycleState,
        category: part.category,
        depth,
      });
      nextFrontier.push(part.id);
    }
    frontier = nextFrontier;
  }

  return found;
}

/**
 * Resolve every where-used facet for a single file. Unlike parts, the
 * walk is flat — one layer of each relationship is sufficient because
 * a file isn't itself a "container" in the same way an assembly part is.
 */
export async function getFileWhereUsed(
  db: DbClient,
  tenantId: string,
  fileId: string
): Promise<FileWhereUsed> {
  const [bomItemsResult, representsResult, partsResult, ecosResult] = await Promise.all([
    db
      .from("bom_items")
      .select("quantity, unit, bom:boms!bom_items_bomId_fkey(id, name, revision, status, tenantId)")
      .eq("fileId", fileId),
    // Files that ARE the drawing the BOM is attached to — boms.fileId.
    // This is a qualitatively different signal ("this file represents
    // that BOM") so we surface it as a separate list in the UI.
    db
      .from("boms")
      .select("id, name, revision, status, tenantId")
      .eq("fileId", fileId),
    db
      .from("part_files")
      .select("role, isPrimary, part:parts!part_files_partId_fkey(id, partNumber, name, revision, lifecycleState, category, tenantId)")
      .eq("fileId", fileId),
    db
      .from("eco_items")
      .select("changeType, eco:ecos!eco_items_ecoId_fkey(id, ecoNumber, title, status, implementedAt, createdAt, tenantId)")
      .eq("fileId", fileId),
  ]);

  const boms: WhereUsedBom[] = [];
  for (const row of (bomItemsResult.data ?? []) as AnyRow[]) {
    const bom = row.bom as { id: string; name: string; revision: string; status: string; tenantId: string } | null;
    if (!bom || bom.tenantId !== tenantId) continue;
    boms.push({
      bomId: bom.id,
      bomName: bom.name,
      bomRevision: bom.revision,
      bomStatus: bom.status,
      quantity: (row.quantity as number) ?? 0,
      unit: (row.unit as string) ?? "EA",
    });
  }

  const representsBoms: WhereUsedBom[] = [];
  for (const row of (representsResult.data ?? []) as AnyRow[]) {
    if ((row.tenantId as string) !== tenantId) continue;
    representsBoms.push({
      bomId: row.id as string,
      bomName: row.name as string,
      bomRevision: row.revision as string,
      bomStatus: row.status as string,
      // No line-item quantity applies here — the file represents the
      // whole BOM, not a line. Use 1 EA so the shared UI can render
      // the row without branching on a separate shape.
      quantity: 1,
      unit: "EA",
    });
  }

  const linkedParts: WhereUsedPart[] = [];
  for (const row of (partsResult.data ?? []) as AnyRow[]) {
    const part = row.part as
      | {
          id: string;
          partNumber: string;
          name: string;
          revision: string;
          lifecycleState: string;
          category: string;
          tenantId: string;
        }
      | null;
    if (!part || part.tenantId !== tenantId) continue;
    linkedParts.push({
      partId: part.id,
      partNumber: part.partNumber,
      name: part.name,
      revision: part.revision,
      lifecycleState: part.lifecycleState,
      category: part.category,
      role: (row.role as string) ?? undefined,
      isPrimary: (row.isPrimary as boolean) ?? undefined,
    });
  }

  const ecos: WhereUsedEco[] = [];
  for (const row of (ecosResult.data ?? []) as AnyRow[]) {
    const eco = row.eco as
      | {
          id: string;
          ecoNumber: string;
          title: string;
          status: string;
          implementedAt: string | null;
          createdAt: string;
          tenantId: string;
        }
      | null;
    if (!eco || eco.tenantId !== tenantId) continue;
    ecos.push({
      ecoId: eco.id,
      ecoNumber: eco.ecoNumber,
      title: eco.title,
      status: eco.status,
      implementedAt: eco.implementedAt,
      createdAt: eco.createdAt,
      changeType: (row.changeType as string | null) ?? null,
    });
  }

  return {
    boms,
    representsBoms,
    linkedParts,
    ecos: sortEcosByRecency(ecos),
  };
}
