import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const tenantUser = await getCurrentTenantUser();
    const permissions = tenantUser.role.permissions as string[];
    const { fileId } = await params;

    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const file = await prisma.file.findUnique({ where: { id: fileId } });
    if (!file || file.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const { metadata, partNumber, description } = await request.json();

    // Update file-level fields
    await prisma.file.update({
      where: { id: fileId },
      data: {
        partNumber: partNumber ?? file.partNumber,
        description: description ?? file.description,
      },
    });

    // Update metadata values
    if (metadata && Array.isArray(metadata)) {
      for (const { fieldId, value } of metadata) {
        await prisma.metadataValue.upsert({
          where: {
            fileId_fieldId: { fileId, fieldId },
          },
          create: { fileId, fieldId, value: String(value) },
          update: { value: String(value) },
        });
      }
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "file.metadata_update",
      entityType: "file",
      entityId: fileId,
      details: { name: file.name },
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Failed to update metadata" },
      { status: 500 }
    );
  }
}
