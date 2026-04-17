import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { requireFileAccess } from "@/lib/folder-access-guards";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    const { fileId } = await params;

    if (!hasPermission(permissions, PERMISSIONS.FILE_DELETE)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const db = getServiceClient();

    const { data: file } = await db.from("files").select("*").eq("id", fileId).single();
    if (!file || file.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const access = await requireFileAccess(tenantUser, file, "edit");
    if (!access.ok) return access.response;

    if (file.isCheckedOut) {
      return NextResponse.json({ error: "Cannot delete a checked-out file" }, { status: 409 });
    }

    if (file.lifecycleState === "Released") {
      return NextResponse.json({ error: "Cannot delete a released file. Mark it as obsolete first." }, { status: 409 });
    }

    // Delete metadata values and file versions, then the file
    await db.from("metadata_values").delete().eq("fileId", fileId);
    await db.from("file_versions").delete().eq("fileId", fileId);
    await db.from("files").delete().eq("id", fileId);

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "file.delete", entityType: "file", entityId: fileId,
      details: { name: file.name },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/files/[fileId] failed:", err);
    return NextResponse.json({ error: "Failed to delete file" }, { status: 500 });
  }
}
