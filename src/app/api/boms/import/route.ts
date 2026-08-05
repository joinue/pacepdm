import { v4 as uuid } from "uuid";
import { withTenant, badRequest } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { parseBuildList, collectParts, findNearMissLinks, type ParsedBom } from "@/lib/bom-import";

/**
 * POST /api/boms/import
 *
 * Imports a QuickBooks-derived build list: one CSV describing many BOMs,
 * with the assembly hierarchy expressed by name reference. See
 * `src/lib/bom-import.ts` for the format and its traps; this route owns
 * only persistence.
 *
 * Whole-file, not per-BOM. The plan originally specced this as
 * `POST /api/boms/[bomId]/import` on the assumption of an indented
 * SolidWorks export with one BOM per file. The real archive format defines
 * 26 BOMs that reference each other, and splitting it into 26 uploads would
 * make `linkedBomId` unresolvable until the last one landed.
 *
 * Body: raw CSV (Content-Type: text/csv) or a FormData `file` field — same
 * as `POST /api/parts/import`, and read the same way. It is not declared as
 * a `body` schema on the wrapper because the wrapper's `body` parses JSON.
 *
 * **Not transactional, by design.** A file with three bad rows lands the
 * other 397 and reports the three, matching the parts importer. The failure
 * mode that matters — a half-built BOM whose items reference a BOM that was
 * never created — is prevented by ordering instead: every BOM row is
 * created before any item row, so link resolution never depends on where
 * the run got to.
 *
 * Re-running is safe. A BOM whose name already exists is skipped and
 * reported rather than duplicated or silently merged, so a second run of
 * the same file is a no-op that tells you so.
 */

interface BomResult {
  partNumber: string;
  status: "created" | "skipped";
  reason?: string;
  itemCount?: number;
}

/** Everything the response tells the caller. Shaped for a per-row UI. */
interface ImportSummary {
  bomsCreated: number;
  bomsSkipped: number;
  partsCreated: number;
  partsUpdated: number;
  itemsCreated: number;
  optionItems: number;
  results: BomResult[];
  problems: { line: number; message: string }[];
  warnings: string[];
}

/** Guard against a paste of the wrong file taking the database with it. */
const MAX_BYTES = 5 * 1024 * 1024;

export const POST = withTenant(
  { permission: PERMISSIONS.FILE_EDIT, name: "POST /api/boms/import" },
  async ({ db, tenantUser, request }) => {
    const contentType = request.headers.get("content-type") || "";
    let csvText: string;
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!file || typeof file === "string") throw badRequest("No CSV file provided");
      csvText = await file.text();
    } else {
      csvText = await request.text();
    }

    if (!csvText.trim()) throw badRequest("Empty CSV body");
    if (csvText.length > MAX_BYTES) throw badRequest("CSV exceeds the 5 MB limit");

    const parsed = parseBuildList(csvText);
    if (parsed.boms.length === 0) {
      throw badRequest(
        "No BOM rows found. The first column must be `BOM` or `Item`; check this is a build list export.",
        { problems: parsed.problems }
      );
    }

    const summary: ImportSummary = {
      bomsCreated: 0,
      bomsSkipped: 0,
      partsCreated: 0,
      partsUpdated: 0,
      itemsCreated: 0,
      optionItems: 0,
      results: [],
      problems: parsed.problems,
      warnings: [],
    };

    const now = new Date().toISOString();

    // ── Pass 1: the part master ──────────────────────────────────────────
    //
    // Upsert by partNumber, matching `POST /api/parts/import`. Every BOM
    // line ends up with a real `partId` — the integration plan requires
    // that before a BOM can reach an ERP, and doing it here means no line
    // is ever created as free text.
    const partSummaries = collectParts(parsed);
    const partNumbers = [...partSummaries.keys()];

    const { data: existingParts, error: partReadError } = await db
      .from("parts")
      .select("id, partNumber, revision, category")
      .in("partNumber", partNumbers);
    if (partReadError) throw new Error(partReadError.message);

    const partIdByNumber = new Map<string, string>();
    for (const row of existingParts ?? []) {
      partIdByNumber.set(row.partNumber as string, row.id as string);
    }

    for (const part of partSummaries.values()) {
      // A part referenced at two different revisions in one file is a data
      // problem in the source, not something to resolve silently.
      if (part.revisionsSeen.length > 1) {
        summary.warnings.push(
          `${part.partNumber} appears at revisions ${part.revisionsSeen.join(", ")}; ` +
            `imported as ${part.revision}.`
        );
      }

      // Category is inferred only where the file actually knows: a part
      // that heads its own BOM is a sub-assembly. Everything else takes the
      // system default rather than a guess — the source distinguishes only
      // "Finished Good" from "Raw Good", which says nothing about whether a
      // leaf is machined in-house or bought in. Fix in bulk later via
      // `POST /api/parts/import`.
      const category = part.isSubAssembly ? "SUB_ASSEMBLY" : "MANUFACTURED";

      const existingId = partIdByNumber.get(part.partNumber);
      if (existingId) {
        // Never overwrite a name or description already curated in PACE
        // with the nothing this file carries for leaf parts.
        const patch: Record<string, unknown> = { updatedAt: now };
        if (part.revision) patch.revision = part.revision;
        if (part.description) patch.description = part.description;
        const { error } = await db.from("parts").update(patch).eq("id", existingId);
        if (error) throw new Error(error.message);
        summary.partsUpdated++;
        continue;
      }

      const id = uuid();
      const { error } = await db.from("parts").insert({
        id,
        partNumber: part.partNumber,
        name: part.description || part.partNumber,
        description: part.description,
        category,
        revision: part.revision || "A",
        createdById: tenantUser.id,
        createdAt: now,
        updatedAt: now,
      });
      if (error) throw new Error(error.message);
      partIdByNumber.set(part.partNumber, id);
      summary.partsCreated++;
    }

    // ── Pass 2: the BOM rows ─────────────────────────────────────────────
    //
    // All of them, before any item row, so `linkedBomId` resolves regardless
    // of the order BOMs appear in the file — the top-level NANO-1000S
    // references sub-assemblies defined 150 lines below it.
    const { data: existingBoms, error: bomReadError } = await db
      .from("boms")
      .select("id, name")
      .is("deletedAt", null);
    if (bomReadError) throw new Error(bomReadError.message);

    const bomIdByNumber = new Map<string, string>();
    const existingNames = new Set(
      ((existingBoms ?? []) as unknown as Array<{ name: string }>).map((b) => b.name)
    );
    const created: ParsedBom[] = [];

    for (const bom of parsed.boms) {
      if (existingNames.has(bom.partNumber)) {
        summary.bomsSkipped++;
        summary.results.push({
          partNumber: bom.partNumber,
          status: "skipped",
          reason: "A BOM with this name already exists",
        });
        continue;
      }

      const id = uuid();
      const { error } = await db.from("boms").insert({
        id,
        name: bom.partNumber,
        revision: bom.revision || "A",
        status: "DRAFT",
        fileId: null,
        createdById: tenantUser.id,
        createdAt: now,
        updatedAt: now,
      });
      if (error) throw new Error(error.message);

      bomIdByNumber.set(bom.partNumber, id);
      existingNames.add(bom.partNumber);
      created.push(bom);
      summary.bomsCreated++;
    }

    // ── Pass 3: the item rows ────────────────────────────────────────────
    for (const bom of created) {
      const bomId = bomIdByNumber.get(bom.partNumber)!;
      const rows = bom.items.map((item) => ({
        id: uuid(),
        bomId,
        itemNumber: String(item.position),
        sortOrder: item.position,
        partId: partIdByNumber.get(item.partNumber) ?? null,
        partNumber: item.partNumber,
        name: item.partNumber,
        quantity: item.quantity,
        unit: item.unit,
        level: 1,
        // The hierarchy is by reference, not by nesting: a line whose part
        // heads its own BOM links to it, and the rollup walks from there.
        linkedBomId: bomIdByNumber.get(item.partNumber) ?? null,
        optionGroup: item.optionGroup,
        optionPrompt: item.optionPrompt,
        createdAt: now,
        updatedAt: now,
      }));

      if (rows.length === 0) continue;
      // lint-conventions-allow: child-table-direct-query — `bom_items` has no
      // tenantId, so ScopedDb cannot filter it. Safe here because `bomId` is
      // an id this handler just minted for a row inserted through the scoped
      // client a few lines above: it cannot name another tenant's BOM.
      const { error } = await db.from("bom_items").insert(rows);
      if (error) throw new Error(error.message);

      summary.itemsCreated += rows.length;
      summary.optionItems += rows.filter((r) => r.optionGroup !== null).length;
      summary.results.push({
        partNumber: bom.partNumber,
        status: "created",
        itemCount: rows.length,
      });

      // One row per BOM rather than a single summary row: the audit trail
      // is per-entity, and `logAudit` requires a real entityId. A reviewer
      // asking "where did this BOM come from" gets the same answer whether
      // it was typed in or imported.
      await logAudit({
        tenantId: tenantUser.tenantId,
        userId: tenantUser.id,
        action: "bom.import",
        entityType: "bom",
        entityId: bomId,
        details: { name: bom.partNumber, revision: bom.revision, itemCount: rows.length },
      });
    }

    // A typo in a part number silently demotes a sub-assembly to a leaf and
    // orphans the BOM it should have linked to. Surfaced as a warning rather
    // than a hard failure: the rest of the file is fine, and only a human can
    // say whether it is a typo or two genuinely different parts.
    for (const miss of findNearMissLinks(parsed)) {
      summary.warnings.push(
        `Line ${miss.sourceLine}: ${miss.bomPartNumber} references "${miss.itemPartNumber}", ` +
          `which does not match any BOM — did it mean "${miss.probableBom}"? ` +
          `It imported as a leaf part, and "${miss.probableBom}" is not linked to anything.`
      );
    }

    // A line pointing at a BOM that was skipped as a duplicate has a null
    // `linkedBomId` and reads as a leaf. Say so rather than leaving a
    // silently flattened hierarchy.
    const unlinked = created
      .flatMap((b) => b.items)
      .filter((i) => partSummaries.get(i.partNumber)?.isSubAssembly)
      .filter((i) => !bomIdByNumber.has(i.partNumber));
    if (unlinked.length > 0) {
      const names = [...new Set(unlinked.map((i) => i.partNumber))];
      summary.warnings.push(
        `${unlinked.length} line(s) reference a sub-assembly that was not created in this run ` +
          `(${names.join(", ")}); they import as leaf items with no linked BOM.`
      );
    }

    return summary;
  }
);
