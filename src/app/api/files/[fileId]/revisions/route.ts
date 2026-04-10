import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";
import { requireFileAccess } from "@/lib/folder-access-guards";

/**
 * GET /api/files/[fileId]/revisions
 *
 * Returns the file's full version history joined with the ECO that
 * released each version (if any). Used by the file detail panel to
 * answer "this file is at revision C — which ECO bumped it from B?"
 *
 * Each row corresponds to one `file_versions` record. `eco` is null
 * for versions that were never linked to an ECO (initial uploads,
 * informal check-ins, pre-traceability rows).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { fileId } = await params;
    const db = getServiceClient();

    // Tenant-scope by joining through files, since file_versions has no
    // tenantId of its own. Cheaper than a separate file lookup because the
    // PostgREST select pulls the file row in the same round trip and we
    // can refuse early if it isn't ours.
    const { data: file } = await db
      .from("files")
      .select("id, tenantId, folderId")
      .eq("id", fileId)
      .single();

    if (!file || file.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const access = await requireFileAccess(tenantUser, file, "view");
    if (!access.ok) return access.response;

    const { data: versions } = await db
      .from("file_versions")
      .select(`
        id,
        version,
        revision,
        fileSize,
        comment,
        createdAt,
        ecoId,
        uploadedBy:tenant_users!file_versions_uploadedById_fkey(fullName),
        eco:ecos!file_versions_ecoId_fkey(id, ecoNumber, title, status)
      `)
      .eq("fileId", fileId)
      .order("version", { ascending: false });

    return NextResponse.json(versions || []);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch file revisions";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
