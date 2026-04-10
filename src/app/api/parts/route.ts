import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { v4 as uuid } from "uuid";
import { z, parseBody, nonEmptyString, optionalString } from "@/lib/validation";

const CreatePartSchema = z.object({
  partNumber: nonEmptyString,
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
  thumbnailUrl: z.string().nullable().optional(),
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
    return NextResponse.json(data || []);
  } catch (err) {
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

    const { data: part, error } = await db.from("parts").insert({
      id: uuid(),
      tenantId: tenantUser.tenantId,
      partNumber: body.partNumber,
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
      thumbnailUrl: body.thumbnailUrl ?? null,
      notes: body.notes ?? null,
      createdById: tenantUser.id,
      createdAt: now,
      updatedAt: now,
    }).select().single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: "A part with this number already exists" }, { status: 409 });
      }
      throw error;
    }

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "part.create", entityType: "part", entityId: part.id,
      details: { partNumber: part.partNumber, name: part.name, category: part.category },
    });

    return NextResponse.json(part);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create part";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
