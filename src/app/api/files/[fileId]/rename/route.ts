import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { z, parseBody, nonEmptyString } from "@/lib/validation";
import { requireFileAccess } from "@/lib/folder-access-guards";

const RenameSchema = z.object({ name: nonEmptyString });

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

    const parsed = await parseBody(request, RenameSchema);
    if (!parsed.ok) return parsed.response;
    const { name } = parsed.data;

    const db = getServiceClient();

    const { data: file } = await db.from("files").select("*").eq("id", fileId).single();
    if (!file || file.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const access = await requireFileAccess(tenantUser, file, "edit");
    if (!access.ok) return access.response;

    // Released/Obsolete files are immutable — name is part of the
    // audit trail. Use Revise to drop back to WIP first.
    if (file.isFrozen) {
      return NextResponse.json({ error: "Cannot rename a frozen/released file. Revise it first." }, { status: 409 });
    }

    // Checked-out files can only be renamed by the checkout owner (or admins)
    if (file.isCheckedOut && file.checkedOutById !== tenantUser.id && !permissions.includes("*")) {
      return NextResponse.json({ error: "File is checked out by another user" }, { status: 423 });
    }

    const oldName = file.name;
    const { error } = await db.from("files")
      .update({ name, updatedAt: new Date().toISOString() })
      .eq("id", fileId);

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: "A file with this name already exists" }, { status: 409 });
      }
      throw error;
    }

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "file.rename", entityType: "file", entityId: fileId,
      details: { oldName, newName: name },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Failed to rename file:", err);
    const message = err instanceof Error ? err.message : "Failed to rename file";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
