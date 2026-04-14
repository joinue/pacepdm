import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";
import { requireFileAccess } from "@/lib/folder-access-guards";
import { getFileWhereUsed } from "@/lib/where-used";

/**
 * GET /api/files/[fileId]/where-used
 *
 * Returns a unified where-used payload for a file:
 *
 *   - `boms`           — BOMs that reference this file as a line item
 *   - `representsBoms` — BOMs where boms.fileId = this file (i.e. this
 *                        file IS the assembly drawing/document the BOM
 *                        is attached to)
 *   - `linkedParts`    — parts that have this file attached via part_files
 *   - `ecos`           — ECOs that have touched this file via eco_items
 *
 * Access is gated through `requireFileAccess` so folder-level
 * permissions are honored. The heavy lifting lives in `lib/where-used.ts`.
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

    const result = await getFileWhereUsed(db, tenantUser.tenantId, fileId);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch where-used data";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
