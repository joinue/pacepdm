import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { v4 as uuid } from "uuid";
import { z, parseBody, nonEmptyString, optionalString, ilikeContains } from "@/lib/validation";
import {
  nextPartNumberSequence,
  formatPartNumber,
  readPartNumberSettings,
  advancePartNumberSequence,
  advanceSequencePastNumbers,
  highestTakenSequence,
} from "@/lib/parts";
import { sideEffect } from "@/lib/notifications";
import { signThumbnailUrls, withThumbnailUrl } from "@/lib/thumbnails";
import { getCostSource, unitCostWouldChange, UNIT_COST_LOCKED_MESSAGE } from "@/lib/cost-source";
import { PART_EDITABLE_STATE } from "@/lib/part-lock";

const CreatePartSchema = z.object({
  // Optional — when omitted and the tenant is in AUTO mode the server allocates
  // the next number from tenants.partNumberSequence. MANUAL mode rejects empty.
  partNumber: z.string().trim().min(1).optional(),
  name: nonEmptyString,
  description: optionalString,
  category: z.string().optional(),
  /** Where the part's revision history starts. Nothing is released by creating it. */
  revision: z.string().optional(),
  /**
   * Accepted only to be refused for anything but WIP: a part becomes Released
   * by implementing an ECO (lib/part-lock.ts). A library of already-released
   * parts arrives through the importer, which records the state it came with.
   */
  lifecycleState: z.string().optional(),
  material: optionalString,
  weight: z.number().nullable().optional(),
  weightUnit: z.string().optional(),
  unitCost: z.number().nullable().optional(),
  /** Engineering estimate. Always writable — see lib/cost-source.ts. */
  estimatedCost: z.number().nullable().optional(),
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
      const term = ilikeContains(q);
      query = query.or(`name.ilike.${term},partNumber.ilike.${term},description.ilike.${term}`);
    }
    if (category && category !== "all") {
      query = query.eq("category", category);
    }
    if (state && state !== "all") {
      query = query.eq("lifecycleState", state);
    }

    const { data } = await query.limit(200);
    const rows = (data || []) as Array<{ thumbnailKey?: string | null }>;

    // Resolve thumbnailKey -> signed URL. The frontend reads `thumbnailUrl`;
    // the storage layout and expiry live in lib/thumbnails.ts.
    const urlByKey = await signThumbnailUrls(
      db.storage,
      rows.map((row) => row.thumbnailKey)
    );

    return NextResponse.json(rows.map((row) => withThumbnailUrl(row, urlByKey)));
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

    if (body.lifecycleState && body.lifecycleState !== PART_EDITABLE_STATE) {
      return NextResponse.json(
        {
          error:
            `A new part starts at ${PART_EDITABLE_STATE}. It reaches ` +
            `${body.lifecycleState} by being carried on an ECO that is implemented — or, for a ` +
            `library that is already released elsewhere, through the parts importer.`,
        },
        { status: 400 }
      );
    }

    const db = getServiceClient();
    const now = new Date().toISOString();

    // Resolve part number based on tenant settings. AUTO mode allocates from
    // the per-tenant sequence and recovers from collisions (a number imported
    // or typed by hand that the counter had not passed yet). MANUAL mode
    // requires the client to provide one.
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
        { status: 400 }
      );
    }

    // Same rule as an edit: under a locked cost source only the connected cost
    // system sets `unitCost`, so a new part may not arrive with one. A null is
    // not a cost and is fine.
    if (
      unitCostWouldChange(null, body.unitCost) &&
      (await getCostSource(db, tenantUser.tenantId)) === "LOCKED"
    ) {
      return NextResponse.json({ error: UNIT_COST_LOCKED_MESSAGE }, { status: 403 });
    }

    const buildRow = (pn: string) => ({
      id: uuid(),
      tenantId: tenantUser.tenantId,
      partNumber: pn,
      name: body.name,
      description: body.description ?? null,
      category: body.category || "MANUFACTURED",
      revision: body.revision || "A",
      lifecycleState: PART_EDITABLE_STATE,
      material: body.material ?? null,
      weight: body.weight ?? null,
      weightUnit: body.weightUnit || "kg",
      unitCost: body.unitCost ?? null,
      estimatedCost: body.estimatedCost ?? null,
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
    // After the first collision the counter is moved past every taken number,
    // so a further collision means another create won a race for the same
    // slot — a handful of attempts is plenty.
    const maxAttempts = partNumber ? 1 : 5;
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
      // supplied it, surface as 409.
      if (body.partNumber) {
        return NextResponse.json(
          { error: "A part with this number already exists" },
          { status: 409 }
        );
      }
      // The counter is behind numbers that arrived some other way — an
      // imported item master, or numbers typed by hand. This used to retry
      // one slot at a time, so a tenant that had imported PRT-00001..00500
      // burned ten numbers per create and got a 409 every time. Jump past the
      // highest number the format could collide with, then allocate again. If
      // the jump itself fails, the next attempt still moves on by one.
      await sideEffect(
        highestTakenSequence(db, tenantUser.tenantId, numberSettings).then((highest) =>
          advancePartNumberSequence(db, tenantUser.tenantId, highest)
        ),
        `advance part number sequence past taken numbers after ${partNumber} collided`
      );
      partNumber = null;
    }
    if (!part) {
      return NextResponse.json(
        { error: lastError?.message || "Could not allocate a unique part number" },
        { status: 409 }
      );
    }

    // A number typed by hand that the counter could also have minted moves
    // the counter past it, so the next automatic number does not collide.
    // Not worth failing a create that has already landed: the collision path
    // above recovers if this is missed.
    if (body.partNumber) {
      await sideEffect(
        advanceSequencePastNumbers(db, tenantUser.tenantId, numberSettings, [part.partNumber]),
        `advance part number sequence past ${part.partNumber}`
      );
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "part.create",
      entityType: "part",
      entityId: part.id,
      details: { partNumber: part.partNumber, name: part.name, category: part.category },
    });

    return NextResponse.json(part);
  } catch (err) {
    console.error("Failed to create part:", err);
    const message = err instanceof Error ? err.message : "Failed to create part";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
