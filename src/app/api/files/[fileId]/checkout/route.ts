import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { requireFileAccess } from "@/lib/folder-access-guards";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    const { fileId } = await params;

    if (!hasPermission(permissions, PERMISSIONS.FILE_CHECKOUT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const db = getServiceClient();

    const { data: file } = await db.from("files").select("*").eq("id", fileId).single();
    if (!file || file.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const access = await requireFileAccess(tenantUser, file, "edit");
    if (!access.ok) return access.response;

    if (file.isFrozen) {
      return NextResponse.json({ error: "Cannot check out a frozen/released file. Revise it first." }, { status: 409 });
    }
    if (file.isCheckedOut) {
      return NextResponse.json({ error: "File is already checked out" }, { status: 409 });
    }

    const { data: updated } = await db
      .from("files")
      .update({
        isCheckedOut: true,
        checkedOutById: tenantUser.id,
        checkedOutAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .eq("id", fileId)
      .select()
      .single();

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "file.checkout",
      entityType: "file",
      entityId: fileId,
      details: { name: file.name },
    });

    return NextResponse.json(updated);
  } catch (err) {
    console.error("POST /api/files/[fileId]/checkout failed:", err);
    return NextResponse.json({ error: "Failed to check out file" }, { status: 500 });
  }
}
