import { NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import { withTenant } from "@/lib/api-route";
import type { ScopedDb } from "@/lib/tenant-db";
import { getApiTenantUser, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { parseCsvRecords } from "@/lib/csv";
import { usesReservedLetter } from "@/lib/revision";
import {
  looksLikeQuickBooksExport,
  parseQuickBooksExport,
  groupByPartNumber,
  chooseRowForPart,
  isUnapplied,
  looksLikeNumberingCollision,
} from "@/lib/quickbooks-import";

/** The resolved caller. `getApiTenantUser` infers its own shape, so derive it. */
type TenantUser = NonNullable<Awaited<ReturnType<typeof getApiTenantUser>>>;

/**
 * POST /api/parts/import
 *
 * Accepts a CSV body and upserts parts by `partNumber`: rows whose
 * partNumber already exists in the tenant are UPDATED, new ones are
 * INSERTED. Returns a per-row result so the UI can show exactly which
 * rows failed and why — the single most common pain point when
 * migrating spreadsheets into a PDM.
 *
 * The request body is the raw CSV as text (Content-Type: text/csv) or
 * as a FormData field `file`. Header names are normalized (lowercased,
 * trimmed) and matched against the column map below. Extra columns are
 * ignored. Missing columns default to null except for partNumber and
 * name, which are required.
 *
 * We intentionally do NOT wrap the import in a transaction. A 500-row
 * spreadsheet with 3 bad rows should land the 497 good ones and
 * surface the 3 for fixing — that's how users actually fix dirty data.
 */

// Header aliases → canonical field name. All headers are lowercased and
// trimmed before lookup. First match wins.
const HEADER_MAP: Record<string, string> = {
  "part number": "partNumber",
  partnumber: "partNumber",
  pn: "partNumber",
  name: "name",
  description: "description",
  category: "category",
  revision: "revision",
  rev: "revision",
  "lifecycle state": "lifecycleState",
  lifecyclestate: "lifecycleState",
  state: "lifecycleState",
  material: "material",
  weight: "weight",
  "weight unit": "weightUnit",
  weightunit: "weightUnit",
  "unit cost": "unitCost",
  unitcost: "unitCost",
  cost: "unitCost",
  currency: "currency",
  unit: "unit",
  notes: "notes",
};

const VALID_CATEGORIES = new Set([
  "MANUFACTURED",
  "PURCHASED",
  "STANDARD_HARDWARE",
  "RAW_MATERIAL",
  "SUB_ASSEMBLY",
]);

interface ParsedRow {
  partNumber: string;
  name: string;
  description: string | null;
  category: string;
  revision: string | null;
  lifecycleState: string | null;
  material: string | null;
  weight: number | null;
  weightUnit: string | null;
  unitCost: number | null;
  currency: string | null;
  unit: string | null;
  notes: string | null;
}

interface RowResult {
  row: number;
  partNumber: string;
  action: "inserted" | "updated" | "failed";
  error?: string;
  /**
   * The row landed, but something about it is worth a second look. Distinct
   * from `error`, which means the row did not land at all.
   */
  warning?: string;
}

/**
 * Non-fatal observations about a row that is otherwise fine.
 *
 * Currently one: a revision using a letter ASME Y14.35 reserves. The standard
 * excludes I, O, Q, S, X and Z because they misread — I and O as 1 and 0, Q as
 * O, S as 5, Z as 2, and X means experimental.
 *
 * Warned rather than rejected, deliberately. An imported part at revision `S`
 * is a fact about the source system, not a mistake this importer gets to
 * refuse — QuickBooks does not know about Y14.35 and the part exists either
 * way. What it does mean is that `nextRevision` cannot sequence it, so the
 * first person to revise that part will be told to set the revision by hand,
 * and this is where they find out why.
 */
function warningsFor(parsed: ParsedRow): string | undefined {
  if (parsed.revision && usesReservedLetter(parsed.revision)) {
    return (
      `Revision "${parsed.revision}" uses a letter ASME Y14.35 reserves ` +
      `(I, O, Q, S, X, Z). Imported as-is, but it cannot be sequenced — ` +
      `revising this part will ask for the next revision by hand.`
    );
  }
  return undefined;
}

function parseOptionalNumber(value: string): number | null {
  if (!value) return null;
  const n = Number(value.replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Map a CSV record (normalized string keys → string values) to a
// typed parts row. Returns a row or an error message — never both.
function buildRow(
  record: Record<string, string>,
  headerMap: Map<string, string>
): { row: ParsedRow } | { error: string } {
  const field = (name: string): string => {
    // Walk the caller's header map in insertion order so the first
    // matching alias wins — mirrors how HEADER_MAP is declared.
    for (const [header, canonical] of headerMap) {
      if (canonical === name) {
        const v = record[header];
        if (v !== undefined && v !== "") return v;
      }
    }
    return "";
  };

  const partNumber = field("partNumber");
  const name = field("name");
  if (!partNumber) return { error: "Missing Part Number" };
  if (!name) return { error: "Missing Name" };

  const categoryRaw = field("category").toUpperCase().replace(/\s+/g, "_");
  const category = categoryRaw || "MANUFACTURED";
  if (!VALID_CATEGORIES.has(category)) {
    return {
      error: `Invalid category "${field("category")}" (allowed: ${Array.from(VALID_CATEGORIES).join(", ")})`,
    };
  }

  return {
    row: {
      partNumber,
      name,
      description: field("description") || null,
      category,
      revision: field("revision") || null,
      lifecycleState: field("lifecycleState") || null,
      material: field("material") || null,
      weight: parseOptionalNumber(field("weight")),
      weightUnit: field("weightUnit") || null,
      unitCost: parseOptionalNumber(field("unitCost")),
      currency: field("currency") || null,
      unit: field("unit") || null,
      notes: field("notes") || null,
    },
  };
}

/**
 * Upper bound on rows parsed from one file.
 *
 * A QuickBooks item export cannot be narrowed on the QuickBooks side — the
 * user gets the whole catalogue or nothing — and PACE's is over 7,000 rows.
 * A cap below that would reject the only file they can actually produce.
 * Writes are bounded far lower and separately: the QuickBooks path only
 * touches parts that already exist here.
 */
const MAX_ROWS = 20000;

/**
 * Decode CSV bytes, preferring UTF-8 and falling back to Windows-1252.
 *
 * QuickBooks writes Windows-1252. Decoding that as UTF-8 does not throw — it
 * substitutes U+FFFD — so µm becomes "�m" and a part description silently
 * loses the one character that made it meaningful. For a metallography
 * business whose catalogue is full of micron sizes, that is most of the
 * descriptions.
 *
 * `fatal: true` is what makes the UTF-8 attempt a real test rather than a
 * formality: it throws on the first invalid sequence, so a genuine UTF-8 file
 * still decodes as UTF-8 and anything else falls through.
 */
function decodeCsv(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/**
 * Import a raw QuickBooks item export.
 *
 * **Update-only, and that is the design rather than a limitation.** The export
 * holds every item the business sells or consumes — 6,000+ part numbers
 * against a parts library of a few hundred. Inserting them all would bury the
 * engineering library in consumables and sales items. Since QuickBooks will
 * not filter the export, the filter is "parts this PDM already knows about",
 * which is exactly the set the BOM import created.
 *
 * So a part appears here because a BOM references it. Enriching those with
 * cost, description and vendor is the whole job; anything else in the file is
 * counted and ignored.
 */
async function importFromQuickBooks(
  db: ScopedDb,
  tenantUser: TenantUser,
  records: Array<Record<string, string>>
) {
  const { rows: parsed, skipped } = parseQuickBooksExport(records);
  const groups = groupByPartNumber(parsed);

  // Read the tenant's own parts rather than querying by 6,000 part numbers.
  // A `.in()` filter with that many values produces a URL PostgREST refuses,
  // and the library is inherently the smaller side of this join.
  const existing = new Map<
    string,
    { id: string; partNumber: string; revision: string | null; name: string }
  >();
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .from("parts")
      .select("id, partNumber, revision, name")
      .eq("tenantId", tenantUser.tenantId)
      .is("deletedAt", null)
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const p of data ?? []) existing.set(p.partNumber as string, p as never);
    if (!data || data.length < PAGE) break;
  }

  const now = new Date().toISOString();
  const results: RowResult[] = [];
  let updated = 0;
  let failed = 0;
  let warned = 0;
  let notInLibrary = 0;

  for (const [partNumber, candidates] of groups) {
    const part = existing.get(partNumber);
    if (!part) {
      notInLibrary++;
      continue;
    }

    const chosen = chooseRowForPart(candidates, part.revision);
    if (!chosen) continue;

    const notes: string[] = [];
    if (chosen.warning) notes.push(chosen.warning);

    // Two components sharing a number is not something an importer may
    // resolve — picking one would put the wrong description and vendor on a
    // part a BOM already references.
    if (candidates.length > 1 && looksLikeNumberingCollision(candidates)) {
      notes.push(
        `The QuickBooks entries describe different things (` +
          candidates.map((c) => `${c.leaf}: "${c.description ?? "—"}"`).join("; ") +
          `). This may be two parts sharing a number rather than revisions of one.`
      );
    }

    if (isUnapplied(chosen, part.revision)) {
      results.push({
        row: chosen.row.sourceRow,
        partNumber,
        action: "failed",
        error: notes.join(" "),
      });
      failed++;
      continue;
    }

    const row = chosen.row;
    const updates: Record<string, unknown> = { updatedAt: now };
    if (row.unitCost !== null) updates.unitCost = row.unitCost;
    if (row.description) updates.description = row.description;
    if (row.weight !== null) updates.weight = row.weight;
    // The ERP's own identifier for this exact revision. See
    // docs/decisions/erp-ownership.md — the systems join on this, never on
    // part number, because the part number no longer matches after the split.
    updates.externalId = row.leaf;
    // Only replace a placeholder name. The BOM importer sets name = part
    // number when it has nothing better; a name somebody curated is left
    // alone.
    if (part.name === part.partNumber && row.description) updates.name = row.description;

    const { error } = await db.from("parts").update(updates).eq("id", part.id);
    if (error) {
      results.push({ row: row.sourceRow, partNumber, action: "failed", error: error.message });
      failed++;
      continue;
    }

    if (row.vendor) {
      // lint-conventions-allow: child-table-direct-query — part_vendors has no
      // tenantId; the parent part was resolved through a tenant-filtered query
      // above, so partId is already known to belong to this tenant.
      const { data: link } = await db
        .from("part_vendors")
        .select("id")
        .eq("partId", part.id)
        .eq("vendorName", row.vendor)
        .maybeSingle();
      if (!link) {
        // lint-conventions-allow: child-table-direct-query — same parent as the
        // lookup directly above; partId is already known to be in this tenant.
        await db.from("part_vendors").insert({
          id: uuid(),
          partId: part.id,
          vendorName: row.vendor,
          unitCost: row.unitCost,
          currency: "USD",
          isPrimary: true,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    const warning = notes.length > 0 ? notes.join(" ") : undefined;
    if (warning) warned++;
    results.push({ row: row.sourceRow, partNumber, action: "updated", warning });
    updated++;
  }

  await logAudit({
    tenantId: tenantUser.tenantId,
    userId: tenantUser.id,
    action: "parts.import",
    entityType: "part",
    entityId: "bulk",
    details: { source: "quickbooks", updated, failed, warned, notInLibrary, rows: records.length },
  });

  return NextResponse.json({
    source: "quickbooks",
    inserted: 0,
    updated,
    failed,
    warned,
    /** Rows that are parts but name something this PDM does not carry. */
    notInLibrary,
    /** Rows that were never parts — services, sales tax items, inactive. */
    notParts: skipped.length,
    total: records.length,
    results,
  });
}

/**
 * Converted to `withTenant` while adding the QuickBooks path.
 *
 * No body schema is declared, deliberately: the wrapper only parses a body
 * when one is, and this route takes raw CSV bytes or a FormData file rather
 * than JSON. `FILE_EDIT` is the same permission the UI paths use — import is
 * not a lower bar.
 */
export const POST = withTenant(
  { permission: PERMISSIONS.FILE_EDIT },
  async ({ db, tenantUser, request }) => {
    // Accept either a raw text/csv body or a multipart/form-data with
    // a `file` field — the UI uses FormData but curl scripts and tools
    // like Insomnia prefer raw bodies.
    let csvText: string;
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "Missing file field" }, { status: 400 });
      }
      csvText = decodeCsv(await file.arrayBuffer());
    } else {
      csvText = decodeCsv(await request.arrayBuffer());
    }

    if (!csvText.trim()) {
      return NextResponse.json({ error: "Empty CSV" }, { status: 400 });
    }

    const { headers, rows } = parseCsvRecords(csvText);
    if (headers.length === 0 || rows.length === 0) {
      return NextResponse.json({ error: "CSV has no data rows" }, { status: 400 });
    }

    // Cap imports to keep a runaway paste job from hammering the DB.
    //
    // Raised from 1000 because a QuickBooks item export cannot be filtered on
    // the QuickBooks side — you get the entire catalogue or nothing, and PACE's
    // is over 7,000 rows covering consumables, services and every machine. A
    // cap below that would reject the only file the user can actually produce.
    //
    // The number of *writes* is bounded separately and much lower: the
    // QuickBooks path only touches parts that already exist here, so 7,000 rows
    // resolve to a few hundred updates at most.
    if (rows.length > MAX_ROWS) {
      return NextResponse.json(
        { error: `Too many rows (${rows.length}). Maximum is ${MAX_ROWS} per import.` },
        { status: 400 }
      );
    }

    // A QuickBooks export is a different shape from our own template and needs
    // its own reader — see src/lib/quickbooks-import.ts for the six things
    // about that file which are not guessable from its header row.
    if (looksLikeQuickBooksExport(headers)) {
      return await importFromQuickBooks(db, tenantUser, rows);
    }

    // Build the header→canonical map once per import. Unknown headers
    // are silently skipped; we keep them in the parsed record so the
    // error messages can reference them if needed.
    const headerMap = new Map<string, string>();
    for (const h of headers) {
      const canonical = HEADER_MAP[h];
      if (canonical) headerMap.set(h, canonical);
    }

    if (!Array.from(headerMap.values()).includes("partNumber")) {
      return NextResponse.json({ error: "CSV must include a Part Number column" }, { status: 400 });
    }
    if (!Array.from(headerMap.values()).includes("name")) {
      return NextResponse.json({ error: "CSV must include a Name column" }, { status: 400 });
    }

    // Fetch every existing part in this tenant that matches any
    // incoming partNumber, in one round trip. We use this to decide
    // insert vs update per row.
    const incomingPartNumbers = Array.from(
      new Set(
        rows
          .map((r) => {
            for (const [header, canonical] of headerMap) {
              if (canonical === "partNumber") {
                const v = r[header];
                if (v) return v.trim();
              }
            }
            return null;
          })
          .filter((v): v is string => !!v)
      )
    );

    const existingById = new Map<string, { id: string }>();
    if (incomingPartNumbers.length > 0) {
      // Includes soft-deleted parts on purpose. parts_tenantId_partNumber_key
      // is a plain unique index, so a deleted part still owns its part
      // number; treating it as absent would send the row down the insert
      // path and fail it with a 23505 the importer can't recover from.
      // Matching it means a re-import revives the row instead.
      const { data: existing } = await db
        .from("parts")
        .select("id, partNumber")
        .eq("tenantId", tenantUser.tenantId)
        .in("partNumber", incomingPartNumbers);
      for (const row of existing ?? []) {
        existingById.set(row.partNumber, { id: row.id });
      }
    }

    const now = new Date().toISOString();
    const results: RowResult[] = [];
    let inserted = 0;
    let updated = 0;
    let failed = 0;
    let warned = 0;

    // Process rows sequentially. Parallelizing would be faster but
    // would fight the per-row error reporting (we want a stable order
    // in the response) and risk unique-constraint races between rows
    // that insert the same partNumber.
    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 2; // +2 for header and 1-based rows
      const built = buildRow(rows[i], headerMap);
      if ("error" in built) {
        results.push({
          row: rowNumber,
          partNumber: rows[i]["part number"] || rows[i]["partnumber"] || "",
          action: "failed",
          error: built.error,
        });
        failed++;
        continue;
      }

      const parsed = built.row;
      const existing = existingById.get(parsed.partNumber);
      const warning = warningsFor(parsed);
      if (warning) warned++;

      try {
        if (existing) {
          const { error } = await db
            .from("parts")
            .update({
              name: parsed.name,
              description: parsed.description,
              category: parsed.category,
              revision: parsed.revision ?? undefined,
              lifecycleState: parsed.lifecycleState ?? undefined,
              material: parsed.material,
              weight: parsed.weight,
              weightUnit: parsed.weightUnit ?? undefined,
              unitCost: parsed.unitCost,
              currency: parsed.currency ?? undefined,
              unit: parsed.unit ?? undefined,
              notes: parsed.notes,
              updatedAt: now,
              // Re-importing a part number that was soft-deleted brings it
              // back, rather than updating a row the user can't see.
              deletedAt: null,
            })
            .eq("id", existing.id);
          if (error) throw error;
          results.push({
            row: rowNumber,
            partNumber: parsed.partNumber,
            action: "updated",
            warning,
          });
          updated++;
        } else {
          const { error } = await db.from("parts").insert({
            id: uuid(),
            tenantId: tenantUser.tenantId,
            partNumber: parsed.partNumber,
            name: parsed.name,
            description: parsed.description,
            category: parsed.category,
            revision: parsed.revision || "A",
            lifecycleState: parsed.lifecycleState || "WIP",
            material: parsed.material,
            weight: parsed.weight,
            weightUnit: parsed.weightUnit || "kg",
            unitCost: parsed.unitCost,
            currency: parsed.currency || "USD",
            unit: parsed.unit || "EA",
            notes: parsed.notes,
            createdById: tenantUser.id,
            createdAt: now,
            updatedAt: now,
          });
          if (error) throw error;
          results.push({
            row: rowNumber,
            partNumber: parsed.partNumber,
            action: "inserted",
            warning,
          });
          inserted++;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          row: rowNumber,
          partNumber: parsed.partNumber,
          action: "failed",
          error: message,
        });
        failed++;
      }
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "parts.import",
      entityType: "part",
      entityId: "bulk",
      details: { inserted, updated, failed, warned, total: rows.length },
    });

    return NextResponse.json({
      inserted,
      updated,
      failed,
      warned,
      total: rows.length,
      results,
    });
  }
);
