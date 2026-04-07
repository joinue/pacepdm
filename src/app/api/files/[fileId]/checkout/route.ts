import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const tenantUser = await getCurrentTenantUser();
    const permissions = tenantUser.role.permissions as string[];
    const { fileId } = await params;

    if (!hasPermission(permissions, PERMISSIONS.FILE_CHECKOUT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const file = await prisma.file.findUnique({ where: { id: fileId } });

    if (!file || file.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    if (file.isCheckedOut) {
      return NextResponse.json(
        { error: "File is already checked out" },
        { status: 409 }
      );
    }

    const updated = await prisma.file.update({
      where: { id: fileId },
      data: {
        isCheckedOut: true,
        checkedOutById: tenantUser.id,
        checkedOutAt: new Date(),
      },
    });

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "file.checkout",
      entityType: "file",
      entityId: fileId,
      details: { name: file.name },
    });

    return NextResponse.json(updated);
  } catch {
    return NextResponse.json(
      { error: "Failed to check out file" },
      { status: 500 }
    );
  }
}
