import { NextRequest, NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { parseCsvRecords } from "@/lib/csv";

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
  "name": "name",
  "description": "description",
  "category": "category",
  "revision": "revision",
  "rev": "revision",
  "lifecycle state": "lifecycleState",
  "lifecyclestate": "lifecycleState",
  "state": "lifecycleState",
  "material": "material",
  "weight": "weight",
  "weight unit": "weightUnit",
  "weightunit": "weightUnit",
  "unit cost": "unitCost",
  "unitcost": "unitCost",
  "cost": "unitCost",
  "currency": "currency",
  "unit": "unit",
  "notes": "notes",
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

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const permissions = tenantUser.role.permissions as string[];
    // Creating and editing parts via import both require FILE_EDIT —
    // same permission as the UI paths. Import is not a lower bar.
    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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
      csvText = await file.text();
    } else {
      csvText = await request.text();
    }

    if (!csvText.trim()) {
      return NextResponse.json({ error: "Empty CSV" }, { status: 400 });
    }

    const { headers, rows } = parseCsvRecords(csvText);
    if (headers.length === 0 || rows.length === 0) {
      return NextResponse.json({ error: "CSV has no data rows" }, { status: 400 });
    }

    // Cap imports to keep a runaway paste job from hammering the DB.
    // Matches the BOM items bulk insert's 1000-row ceiling for consistency.
    if (rows.length > 1000) {
      return NextResponse.json(
        { error: `Too many rows (${rows.length}). Maximum is 1000 per import.` },
        { status: 400 }
      );
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
      return NextResponse.json(
        { error: "CSV must include a Part Number column" },
        { status: 400 }
      );
    }
    if (!Array.from(headerMap.values()).includes("name")) {
      return NextResponse.json(
        { error: "CSV must include a Name column" },
        { status: 400 }
      );
    }

    const db = getServiceClient();

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
            })
            .eq("id", existing.id);
          if (error) throw error;
          results.push({ row: rowNumber, partNumber: parsed.partNumber, action: "updated" });
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
          results.push({ row: rowNumber, partNumber: parsed.partNumber, action: "inserted" });
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
      details: { inserted, updated, failed, total: rows.length },
    });

    return NextResponse.json({
      inserted,
      updated,
      failed,
      total: rows.length,
      results,
    });
  } catch (err) {
    console.error("Failed to import parts:", err);
    const message = err instanceof Error ? err.message : "Failed to import parts";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
