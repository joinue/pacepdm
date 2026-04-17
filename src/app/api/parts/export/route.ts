import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";
import { toCsv } from "@/lib/csv";

/**
 * GET /api/parts/export?q=...&category=...&state=...
 *
 * Streams a CSV of the tenant's parts, honoring the same search and
 * filter params as the parts list endpoint so "export what I'm seeing"
 * works the way engineers expect. The CSV is round-trippable through
 * the import endpoint — same column names, no computed fields, no
 * join payloads that the importer wouldn't know how to reconstruct.
 *
 * Max result set is capped at 10,000 rows. That's a huge catalog for a
 * small-medium team; anything over that probably wants pagination or a
 * different tool.
 */
const EXPORT_LIMIT = 10000;

// The canonical column order for parts import/export. Mirrored by the
// import route so a round-trip (export → edit in Excel → re-import)
// lines up without reordering. Human-friendly headers; the importer
// normalizes them back to field names.
const COLUMNS: { header: string; field: string }[] = [
  { header: "Part Number", field: "partNumber" },
  { header: "Name", field: "name" },
  { header: "Description", field: "description" },
  { header: "Category", field: "category" },
  { header: "Revision", field: "revision" },
  { header: "Lifecycle State", field: "lifecycleState" },
  { header: "Material", field: "material" },
  { header: "Weight", field: "weight" },
  { header: "Weight Unit", field: "weightUnit" },
  { header: "Unit Cost", field: "unitCost" },
  { header: "Currency", field: "currency" },
  { header: "Unit", field: "unit" },
  { header: "Notes", field: "notes" },
];

export async function GET(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const db = getServiceClient();
    const { searchParams } = new URL(request.url);

    const q = searchParams.get("q");
    const category = searchParams.get("category");
    const state = searchParams.get("state");

    let query = db
      .from("parts")
      .select(
        "partNumber, name, description, category, revision, lifecycleState, material, weight, weightUnit, unitCost, currency, unit, notes"
      )
      .eq("tenantId", tenantUser.tenantId)
      .order("partNumber");

    if (q) {
      query = query.or(
        `name.ilike.%${q}%,partNumber.ilike.%${q}%,description.ilike.%${q}%`
      );
    }
    if (category && category !== "all") query = query.eq("category", category);
    if (state && state !== "all") query = query.eq("lifecycleState", state);

    const { data, error } = await query.limit(EXPORT_LIMIT);
    if (error) {
      console.error("[parts/export] query failed:", error);
      return NextResponse.json(
        { error: `Query failed: ${error.message}` },
        { status: 500 }
      );
    }

    const rows = (data ?? []).map((row) =>
      COLUMNS.map((c) => (row as Record<string, unknown>)[c.field])
    );
    const csv = toCsv(
      COLUMNS.map((c) => c.header),
      rows
    );

    // Filename includes an ISO date stamp so repeated exports don't
    // overwrite each other in the user's Downloads folder.
    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="parts-${stamp}.csv"`,
      },
    });
  } catch (err) {
    console.error("Failed to export parts:", err);
    const message = err instanceof Error ? err.message : "Failed to export parts";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
