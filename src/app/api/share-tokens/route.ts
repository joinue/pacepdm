import { NextResponse } from "next/server";
import { withTenant, notFound, badRequest } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { z } from "@/lib/validation";
import {
  createShareToken,
  listShareTokensForResource,
  type ShareResourceType,
} from "@/lib/share-tokens";
import { loadFile } from "@/lib/folder-access-guards";

/**
 * Share links. Converted to `withTenant` when part shares landed — the
 * domain was hand-rolling auth, the permission check and the tenant
 * filter, and adding a fourth resource type to that shape would have
 * meant writing the tenant filter by hand a fourth time.
 *
 * `part` is the type sourcing actually uses: it resolves to the part's
 * released files at view time, so a bookmarked link follows revisions
 * rather than going stale. See src/lib/part-package.ts.
 */

const RESOURCE_TYPES = ["file", "bom", "release", "part"] as const;

// The password field is optional and only ever travels over HTTPS; it is
// hashed server-side before the row is written.
const CreateSchema = z.object({
  resourceType: z.enum(RESOURCE_TYPES),
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
  /**
   * Part shares only. Include unreleased documents, stamped PRELIMINARY in
   * the viewer and prefixed in the zip. Defaults false — a caller that does
   * not mention it gets released-only, which is the behaviour every link
   * created before migration 050 has.
   */
  includeWip: z.boolean().optional().default(false),
});

const ListSchema = z.object({
  resourceType: z.enum(RESOURCE_TYPES),
  resourceId: z.string().min(1),
});

/**
 * Absolute base URL for constructed share URLs. Prefers
 * NEXT_PUBLIC_APP_URL; falls back to the request origin so preview
 * deployments and localhost both produce working links.
 */
function baseUrlFrom(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  return new URL(request.url).origin;
}

export const POST = withTenant(
  { permission: PERMISSIONS.SHARE_CREATE, body: CreateSchema },
  async ({ db, tenantUser, body, request }) => {
    // Only a part package has a released/unreleased distinction to opt out
    // of. Accepting the flag elsewhere would store a value nothing reads,
    // which later reads as "this link was allowed to include WIP" when it
    // never could.
    if (body.includeWip && body.resourceType !== "part") {
      throw badRequest("includeWip applies to part shares only");
    }

    // Verify the target exists and is visible to *this* caller. Holding
    // SHARE_CREATE tenant-wide must not let someone mint a link for a
    // file in a folder they personally cannot see.
    if (body.resourceType === "file") {
      await loadFile(db, tenantUser, body.resourceId, "view");
    } else if (body.resourceType === "bom") {
      const { data: bom } = await db
        .from("boms")
        .select("id")
        .eq("id", body.resourceId)
        .is("deletedAt", null)
        .maybeSingle();
      if (!bom) throw notFound("BOM not found");
    } else if (body.resourceType === "part") {
      const { data: part } = await db
        .from("parts")
        .select("id")
        .eq("id", body.resourceId)
        .is("deletedAt", null)
        .maybeSingle();
      if (!part) throw notFound("Part not found");
    } else {
      const { data: release } = await db
        .from("releases")
        .select("id")
        .eq("id", body.resourceId)
        .maybeSingle();
      if (!release) throw notFound("Release not found");
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
      includeWip: body.includeWip,
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
        // Recorded so "was this supplier sent preliminary drawings, and who
        // decided that" is answerable from the audit log months later.
        includeWip: created.includeWip,
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
  }
);

export const GET = withTenant(
  // Listing tokens exposes the public URL — same sensitivity as minting
  // one, so it takes the same permission. Without this, any tenant member
  // could enumerate active share URLs by guessing resource ids.
  { permission: PERMISSIONS.SHARE_CREATE, query: ListSchema },
  async ({ tenantUser, query, request }) => {
    const rows = await listShareTokensForResource(
      tenantUser.tenantId,
      query.resourceType as ShareResourceType,
      query.resourceId
    );

    const base = baseUrlFrom(request);
    return rows.map(({ passwordHash, ...row }) => ({
      ...row,
      hasPassword: !!passwordHash,
      url: `${base}/share/${row.token}`,
    }));
  }
);
