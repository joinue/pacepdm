import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { v4 as uuid } from "uuid";
import { z, parseBody, nonEmptyString, optionalString } from "@/lib/validation";
import { nextPartNumberSequence, formatPartNumber, readPartNumberSettings } from "@/lib/parts";

const CreatePartSchema = z.object({
  // Optional — when omitted and the tenant is in AUTO mode the server allocates
  // the next number from tenants.partNumberSequence. MANUAL mode rejects empty.
  partNumber: z.string().trim().min(1).optional(),
  name: nonEmptyString,
  description: optionalString,
  category: z.string().optional(),
  revision: z.string().optional(),
  lifecycleState: z.string().optional(),
  material: optionalString,
  weight: z.number().nullable().optional(),
  weightUnit: z.string().optional(),
  unitCost: z.number().nullable().optional(),
  currency: z.string().optional(),
  unit: z.string().optional(),
  notes: optionalString,
});

export async function GET(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const db = getServiceClient();
    const { searchParams } = new URL(request.url);

    const q = searchParams.get("q");
    const category = searchParams.get("category");
    const state = searchParams.get("state");

    let query = db
      .from("parts")
      .select("*")
      .eq("tenantId", tenantUser.tenantId)
      .is("deletedAt", null)
      .order("partNumber");

    if (q) {
      query = query.or(`name.ilike.%${q}%,partNumber.ilike.%${q}%,description.ilike.%${q}%`);
    }
    if (category && category !== "all") {
      query = query.eq("category", category);
    }
    if (state && state !== "all") {
      query = query.eq("lifecycleState", state);
    }

    const { data } = await query.limit(200);
    const rows = data || [];

    // Resolve thumbnailKey -> signed URL (300s, matches files module).
    // Frontend continues to read `thumbnailUrl` so callers don't need to
    // change shape. Storage object lives in the "vault" bucket under
    // `{tenantId}/thumbnails/parts/`.
    const withThumbs = await Promise.all(
      rows.map(async (row) => {
        const key = (row as { thumbnailKey: string | null }).thumbnailKey;
        if (!key) return { ...row, thumbnailUrl: null };
        const { data: signed } = await db.storage.from("vault").createSignedUrl(key, 300);
        return { ...row, thumbnailUrl: signed?.signedUrl || null };
      }),
    );

    return NextResponse.json(withThumbs);
  } catch (err) {
    console.error("Failed to fetch parts:", err);
    const message = err instanceof Error ? err.message : "Failed to fetch parts";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, CreatePartSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const db = getServiceClient();
    const now = new Date().toISOString();

    // Resolve part number based on tenant settings. AUTO mode allocates from
    // the per-tenant sequence and retries past collisions (e.g. if a user has
    // previously typed a number that happens to collide with the next slot).
    // MANUAL mode requires the client to provide one.
    const { data: tenantRow } = await db
      .from("tenants")
      .select("settings")
      .eq("id", tenantUser.tenantId)
      .single();
    const numberSettings = readPartNumberSettings(tenantRow?.settings);

    let partNumber = body.partNumber?.trim() || null;
    if (!partNumber && numberSettings.mode === "MANUAL") {
      return NextResponse.json(
        { error: "Part number is required (this workspace is in manual numbering mode)" },
        { status: 400 },
      );
    }

    const buildRow = (pn: string) => ({
      id: uuid(),
      tenantId: tenantUser.tenantId,
      partNumber: pn,
      name: body.name,
      description: body.description ?? null,
      category: body.category || "MANUFACTURED",
      revision: body.revision || "A",
      lifecycleState: body.lifecycleState || "WIP",
      material: body.material ?? null,
      weight: body.weight ?? null,
      weightUnit: body.weightUnit || "kg",
      unitCost: body.unitCost ?? null,
      currency: body.currency || "USD",
      unit: body.unit || "EA",
      notes: body.notes ?? null,
      createdById: tenantUser.id,
      createdAt: now,
      updatedAt: now,
    });

    type PartRow = { id: string; partNumber: string; name: string; category: string };
    let part: PartRow | null = null;
    let lastError: { code?: string; message?: string } | null = null;
    const maxAttempts = partNumber ? 1 : 10;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (!partNumber) {
        const seq = await nextPartNumberSequence(db, tenantUser.tenantId);
        partNumber = formatPartNumber(seq, numberSettings);
      }
      const { data, error } = await db.from("parts").insert(buildRow(partNumber)).select().single();
      if (!error) {
        part = data;
        break;
      }
      lastError = error;
      if (error.code !== "23505") throw error;
      // Collision: a part already exists with this number. If the client
      // supplied it, surface as 409. Otherwise loop and allocate the next
      // sequence value.
      if (body.partNumber) {
        return NextResponse.json({ error: "A part with this number already exists" }, { status: 409 });
      }
      partNumber = null;
    }
    if (!part) {
      return NextResponse.json(
        { error: lastError?.message || "Could not allocate a unique part number" },
        { status: 409 },
      );
    }

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "part.create", entityType: "part", entityId: part.id,
      details: { partNumber: part.partNumber, name: part.name, category: part.category },
    });

    return NextResponse.json(part);
  } catch (err) {
    console.error("Failed to create part:", err);
    const message = err instanceof Error ? err.message : "Failed to create part";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
