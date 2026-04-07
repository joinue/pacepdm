import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

export async function GET(request: NextRequest) {
  try {
    const tenantUser = await getCurrentTenantUser();
    const { searchParams } = new URL(request.url);
    const parentId = searchParams.get("parentId");

    const folders = await prisma.folder.findMany({
      where: {
        tenantId: tenantUser.tenantId,
        parentId: parentId || null,
      },
      orderBy: { name: "asc" },
      include: {
        _count: {
          select: {
            children: true,
            files: true,
          },
        },
      },
    });

    return NextResponse.json(folders);
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch folders" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getCurrentTenantUser();
    const permissions = tenantUser.role.permissions as string[];

    if (!hasPermission(permissions, PERMISSIONS.FOLDER_CREATE)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { name, parentId } = await request.json();

    if (!name || !name.trim()) {
      return NextResponse.json(
        { error: "Folder name is required" },
        { status: 400 }
      );
    }

    // Build path
    let parentPath = "/";
    if (parentId) {
      const parent = await prisma.folder.findUnique({
        where: { id: parentId },
      });
      if (!parent || parent.tenantId !== tenantUser.tenantId) {
        return NextResponse.json(
          { error: "Parent folder not found" },
          { status: 404 }
        );
      }
      parentPath = parent.path === "/" ? "/" : parent.path + "/";
    }

    const path = parentPath + name.trim();

    const folder = await prisma.folder.create({
      data: {
        tenantId: tenantUser.tenantId,
        name: name.trim(),
        parentId: parentId || null,
        path,
      },
    });

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "folder.create",
      entityType: "folder",
      entityId: folder.id,
      details: { name: folder.name, path: folder.path },
    });

    return NextResponse.json(folder);
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.message.includes("Unique constraint")
    ) {
      return NextResponse.json(
        { error: "A folder with this name already exists here" },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: "Failed to create folder" },
      { status: 500 }
    );
  }
}
