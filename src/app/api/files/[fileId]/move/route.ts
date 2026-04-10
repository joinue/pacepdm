import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { z, parseBody, nonEmptyString } from "@/lib/validation";

const MoveSchema = z.object({ folderId: nonEmptyString });

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    const { fileId } = await params;

    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, MoveSchema);
    if (!parsed.ok) return parsed.response;
    const { folderId } = parsed.data;

    const db = getServiceClient();

    const { data: file } = await db.from("files").select("*").eq("id", fileId).single();
    if (!file || file.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const { data: folder } = await db.from("folders").select("id, path, tenantId").eq("id", folderId).single();
    if (!folder || folder.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "Target folder not found" }, { status: 404 });
    }

    const { error } = await db.from("files")
      .update({ folderId, updatedAt: new Date().toISOString() })
      .eq("id", fileId);

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: "A file with this name already exists in the target folder" }, { status: 409 });
      }
      throw error;
    }

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "file.move", entityType: "file", entityId: fileId,
      details: { name: file.name, toFolder: folder.path },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to move file";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
