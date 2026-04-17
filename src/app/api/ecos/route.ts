import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { notify, sideEffect } from "@/lib/notifications";
import { v4 as uuid } from "uuid";
import { z, parseBody, nonEmptyString, optionalString } from "@/lib/validation";

const CreateEcoSchema = z.object({
  title: nonEmptyString,
  description: optionalString,
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  reason: optionalString,
  changeType: optionalString,
});

export async function GET() {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const db = getServiceClient();

    // Include the createdBy join so the list has the same shape as the
    // single-ECO GET — lets the client use one data source for both the
    // sidebar list and the detail panel, without a second fetch per row.
    const { data: ecos } = await db
      .from("ecos")
      .select("*, createdBy:tenant_users!ecos_createdById_fkey(fullName, email)")
      .eq("tenantId", tenantUser.tenantId)
      .order("createdAt", { ascending: false });

    return NextResponse.json(ecos || []);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch ECOs";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];

    if (!hasPermission(permissions, PERMISSIONS.ECO_CREATE)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, CreateEcoSchema);
    if (!parsed.ok) return parsed.response;
    const { title, description, priority, reason, changeType } = parsed.data;

    const db = getServiceClient();
    const now = new Date().toISOString();
    const idempotencyKey = request.headers.get("idempotency-key") || null;

    // Idempotency: return existing ECO if a matching key exists.
    if (idempotencyKey) {
      const { data: existing } = await db
        .from("ecos")
        .select("*")
        .eq("tenantId", tenantUser.tenantId)
        .eq("clientRequestKey", idempotencyKey)
        .maybeSingle();
      if (existing) return NextResponse.json(existing);
    }

    // Generate ECO number based on total count for this tenant
    const { count } = await db
      .from("ecos")
      .select("*", { count: "exact", head: true })
      .eq("tenantId", tenantUser.tenantId);

    const ecoNumber = `ECO-${String((count || 0) + 1).padStart(4, "0")}`;

    const { data: eco, error } = await db
      .from("ecos")
      .insert({
        id: uuid(),
        tenantId: tenantUser.tenantId,
        ecoNumber,
        title,
        description: description ?? null,
        status: "DRAFT",
        priority: priority || "MEDIUM",
        reason: reason ?? null,
        changeType: changeType ?? null,
        costImpact: null,
        disposition: null,
        effectivity: null,
        createdById: tenantUser.id,
        clientRequestKey: idempotencyKey,
        createdAt: now,
        updatedAt: now,
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505" && idempotencyKey) {
        const { data: existing } = await db
          .from("ecos")
          .select("*")
          .eq("tenantId", tenantUser.tenantId)
          .eq("clientRequestKey", idempotencyKey)
          .maybeSingle();
        if (existing) return NextResponse.json(existing);
      }
      throw error;
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "eco.create",
      entityType: "eco",
      entityId: eco.id,
      details: { ecoNumber, title },
    });

    // Notify users with eco.approve permission about the new ECO
    const { data: admins } = await db
      .from("tenant_users")
      .select("id, role:roles!inner(permissions)")
      .eq("tenantId", tenantUser.tenantId)
      .neq("id", tenantUser.id);

    const adminIds = (admins || [])
      .filter((u) => {
        const role = u.role as unknown as { permissions: string[] };
        const perms = role?.permissions || [];
        return perms.includes("*") || perms.includes("eco.approve");
      })
      .map((u) => u.id);

    if (adminIds.length > 0) {
      await sideEffect(
        notify({
          tenantId: tenantUser.tenantId,
          userIds: adminIds,
          title: "New ECO created",
          message: `${tenantUser.fullName} created ${ecoNumber}: ${title}`,
          type: "eco",
          link: `/ecos`,
          refId: eco.id,
          actorId: tenantUser.id,
        }),
        `notify approvers about new ECO ${ecoNumber}`
      );
    }

    return NextResponse.json(eco);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create ECO";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
