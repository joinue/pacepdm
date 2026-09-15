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

const ECO_NUMBER_PATTERN = /^ECO-(\d+)$/;
const ECO_NUMBER_ATTEMPTS = 5;
// PostgREST's default max-rows. A page shorter than this is the last one.
const ECO_NUMBER_PAGE_SIZE = 1000;

function formatEcoNumber(sequence: number): string {
  return `ECO-${String(sequence).padStart(4, "0")}`;
}

/**
 * Is this a unique violation on (tenantId, ecoNumber), as opposed to the
 * idempotency-key index? Both are 23505, and only this one means "pick
 * another number". Read from the constraint name in the message and the
 * column list in the details, never from the key values — those include the
 * client's idempotency key, which could contain any text.
 */
function isEcoNumberCollision(error: { code?: string; message?: string; details?: string }) {
  if (error.code !== "23505") return false;
  const constraint = /unique constraint "([^"]+)"/.exec(error.message ?? "")?.[1] ?? "";
  const columns = /^Key \(([^)]*)\)=/.exec(error.details ?? "")?.[1] ?? "";
  return constraint.includes("ecoNumber") || columns.includes("ecoNumber");
}

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
      .is("deletedAt", null)
      .order("createdAt", { ascending: false })
      .limit(500);

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
    // Not filtered by deletedAt on purpose — ecos_tenant_idempotency_key
    // is unique across deleted rows too, so skipping them here would make
    // a retry-after-delete fall through to an insert that can only 23505.
    if (idempotencyKey) {
      const { data: existing } = await db
        .from("ecos")
        .select("*")
        .eq("tenantId", tenantUser.tenantId)
        .eq("clientRequestKey", idempotencyKey)
        .maybeSingle();
      if (existing) return NextResponse.json(existing);
    }

    // The next ECO number is one past the highest this tenant has ever
    // issued, soft-deleted rows included: ECO numbers appear on released
    // documentation, so a deleted ECO's number is never handed out again.
    //
    // This used to be the row count plus one, which assumed the numbers ran
    // 1..count with no gaps. Any gap (a row hard-deleted before soft delete
    // existed, or a number skipped by a concurrent create) made count + 1 an
    // existing number, and every create after it failed on the unique index
    // until someone intervened.
    const highestEcoSequence = async (): Promise<number> => {
      let highest = 0;
      for (let from = 0; ; from += ECO_NUMBER_PAGE_SIZE) {
        const { data: rows, error: readError } = await db
          .from("ecos")
          .select("ecoNumber")
          .eq("tenantId", tenantUser.tenantId)
          .order("id")
          .range(from, from + ECO_NUMBER_PAGE_SIZE - 1);
        if (readError) throw readError;
        for (const row of rows ?? []) {
          const match = ECO_NUMBER_PATTERN.exec((row.ecoNumber as string | null) ?? "");
          if (match) highest = Math.max(highest, Number(match[1]));
        }
        if (!rows || rows.length < ECO_NUMBER_PAGE_SIZE) return highest;
      }
    };

    let sequence = (await highestEcoSequence()) + 1;
    let eco = null;

    for (let attempt = 1; ; attempt++) {
      const { data, error } = await db
        .from("ecos")
        .insert({
          id: uuid(),
          tenantId: tenantUser.tenantId,
          ecoNumber: formatEcoNumber(sequence),
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

      if (!error) {
        eco = data;
        break;
      }

      // Two creates read the same highest number and both chose the next
      // one. The loser moves past whatever is there now and tries again.
      if (isEcoNumberCollision(error)) {
        if (attempt >= ECO_NUMBER_ATTEMPTS) {
          return NextResponse.json(
            { error: "Could not allocate a unique ECO number. Please try again." },
            { status: 409 }
          );
        }
        sequence = Math.max(sequence, await highestEcoSequence()) + 1;
        continue;
      }

      // Race: another request with the same idempotency key landed first.
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

    const ecoNumber = eco.ecoNumber as string;

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
