import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentTenantUser } from "@/lib/auth";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const tenantUser = await getCurrentTenantUser();
    const { fileId } = await params;

    const file = await prisma.file.findUnique({
      where: { id: fileId },
      include: {
        folder: true,
        checkedOutBy: { select: { fullName: true, email: true } },
        versions: {
          orderBy: { version: "desc" },
          include: {
            uploadedBy: { select: { fullName: true } },
          },
        },
        metadata: {
          include: {
            field: true,
          },
        },
        references: {
          include: {
            targetFile: { select: { id: true, name: true, partNumber: true } },
          },
        },
        referencedBy: {
          include: {
            sourceFile: {
              select: { id: true, name: true, partNumber: true },
            },
          },
        },
      },
    });

    if (!file || file.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    return NextResponse.json(file);
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch file" },
      { status: 500 }
    );
  }
}
