import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { z, parseBody, parseSearchParams } from "@/lib/validation";
import {
  createShareToken,
  listShareTokensForResource,
  type ShareResourceType,
} from "@/lib/share-tokens";
import { requireFileAccess } from "@/lib/folder-access-guards";

// Shape of the POST body. The password field is optional and only ever
// travels over HTTPS; we hash it server-side before writing the row.
const CreateSchema = z.object({
  resourceType: z.enum(["file", "bom", "release"]),
  resourceId: z.string().min(1),
  expiresAt: z
    .string()
    .datetime()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  allowDownload: z.boolean().optional().default(true),
  password: z
    .string()
    .min(1)
    .max(200)
    .nullable()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
  label: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

const ListSchema = z.object({
  resourceType: z.enum(["file", "bom", "release"]),
  resourceId: z.string().min(1),
});

/**
 * Return the absolute base URL to use when constructing share URLs.
 * Prefers NEXT_PUBLIC_APP_URL if set; falls back to the request origin.
 * We don't hardcode pacepdm.com because the same handler serves preview
 * deployments and localhost dev.
 */
function baseUrlFrom(request: NextRequest): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  return request.nextUrl.origin;
}

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.SHARE_CREATE)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, CreateSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const db = getServiceClient();

    // Verify the target resource exists, belongs to this tenant, and that
    // the caller has the necessary view access. A user with SHARE_CREATE
    // tenant-wide still shouldn't be able to mint a link for a file in a
    // folder they personally can't see.
    if (body.resourceType === "file") {
      const { data: file } = await db
        .from("files")
        .select("*")
        .eq("id", body.resourceId)
        .eq("tenantId", tenantUser.tenantId)
        .single();
      if (!file) {
        return NextResponse.json({ error: "File not found" }, { status: 404 });
      }
      const access = await requireFileAccess(tenantUser, file, "view");
      if (!access.ok) return access.response;
    } else if (body.resourceType === "bom") {
      const { data: bom } = await db
        .from("boms")
        .select("id")
        .eq("id", body.resourceId)
        .eq("tenantId", tenantUser.tenantId)
        .single();
      if (!bom) {
        return NextResponse.json({ error: "BOM not found" }, { status: 404 });
      }
    } else {
      // release
      const { data: release } = await db
        .from("releases")
        .select("id")
        .eq("id", body.resourceId)
        .eq("tenantId", tenantUser.tenantId)
        .single();
      if (!release) {
        return NextResponse.json({ error: "Release not found" }, { status: 404 });
      }
    }

    const created = await createShareToken({
      tenantId: tenantUser.tenantId,
      createdById: tenantUser.id,
      resourceType: body.resourceType as ShareResourceType,
      resourceId: body.resourceId,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      allowDownload: body.allowDownload ?? true,
      password: body.password,
      label: body.label,
    });

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "share.create",
      entityType: body.resourceType,
      entityId: body.resourceId,
      details: {
        tokenId: created.id,
        hasPassword: !!body.password,
        expiresAt: created.expiresAt,
        allowDownload: created.allowDownload,
      },
    });

    // Never return the raw hash. Strip it and surface a boolean flag.
    const safe: Record<string, unknown> = { ...created };
    delete safe.passwordHash;
    return NextResponse.json({
      ...safe,
      hasPassword: !!created.passwordHash,
      url: `${baseUrlFrom(request)}/share/${created.token}`,
    });
  } catch (err) {
    console.error("Failed to create share link:", err);
    const message = err instanceof Error ? err.message : "Failed to create share link";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const parsed = parseSearchParams(request, ListSchema);
    if (!parsed.ok) return parsed.response;
    const { resourceType, resourceId } = parsed.data;

    const rows = await listShareTokensForResource(
      tenantUser.tenantId,
      resourceType as ShareResourceType,
      resourceId
    );

    const base = baseUrlFrom(request);
    // Strip passwordHash; surface hasPassword flag + built URL.
    const safe = rows.map(({ passwordHash, ...row }) => ({
      ...row,
      hasPassword: !!passwordHash,
      url: `${base}/share/${row.token}`,
    }));

    return NextResponse.json(safe);
  } catch (err) {
    console.error("Failed to list share links:", err);
    const message = err instanceof Error ? err.message : "Failed to list share links";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
