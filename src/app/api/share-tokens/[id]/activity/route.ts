import { NextRequest, NextResponse } from "next/server";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { z, parseSearchParams } from "@/lib/validation";
import {
  getShareTokenById,
  listShareTokenAccess,
} from "@/lib/share-tokens";

// Cap on a single page of activity rows. The recursive resolve+view+download
// triple per visit means a busy link can rack up rows fast; a 100-row cap
// keeps the response payload bounded and the index scan cheap.
const MAX_PAGE = 100;

const QuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? 50 : Number(v)))
    .pipe(z.number().int().min(1).max(MAX_PAGE)),
  before: z
    .string()
    .datetime()
    .optional()
    .transform((v) => v ?? null),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const token = await getShareTokenById(tenantUser.tenantId, id);
    if (!token) {
      return NextResponse.json({ error: "Share link not found" }, { status: 404 });
    }

    // Authorize: token creator can always see; otherwise require the same
    // SHARE_CREATE permission that gates revoke. This keeps the permission
    // surface small (no new permission concept) while still preventing
    // random viewers from reading PII (IP/UA) on links they didn't create.
    const permissions = tenantUser.role.permissions as string[];
    const isCreator = token.createdById === tenantUser.id;
    const isManager = hasPermission(permissions, PERMISSIONS.SHARE_CREATE);
    if (!isCreator && !isManager) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = parseSearchParams(request, QuerySchema);
    if (!parsed.ok) return parsed.response;

    const rows = await listShareTokenAccess(tenantUser.tenantId, id, {
      limit: parsed.data.limit,
      before: parsed.data.before,
    });

    // Cursor for the next page: only return one when we filled the page.
    // A short page means we hit the end and there's nothing more to fetch.
    const nextBefore =
      rows.length === parsed.data.limit ? rows[rows.length - 1].createdAt : null;

    return NextResponse.json({ rows, nextBefore });
  } catch (err) {
    console.error("Failed to load share activity:", err);
    const message =
      err instanceof Error ? err.message : "Failed to load share activity";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
