import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getCurrentTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { v4 as uuid } from "uuid";

export async function GET(request: NextRequest) {
  try {
    const tenantUser = await getCurrentTenantUser();
    const { searchParams } = new URL(request.url);
    const parentId = searchParams.get("parentId");

    const db = getServiceClient();

    let query = db
      .from("folders")
      .select("*")
      .eq("tenantId", tenantUser.tenantId)
      .order("name");

    if (parentId) {
      query = query.eq("parentId", parentId);
    } else {
      query = query.is("parentId", null);
    }

    const { data: folders } = await query;

    // Get counts for each folder
    const foldersWithCounts = await Promise.all(
      (folders || []).map(async (folder) => {
        const [{ count: childCount }, { count: fileCount }] = await Promise.all([
          db.from("folders").select("*", { count: "exact", head: true }).eq("parentId", folder.id),
          db.from("files").select("*", { count: "exact", head: true }).eq("folderId", folder.id),
        ]);
        return {
          ...folder,
          _count: { children: childCount || 0, files: fileCount || 0 },
        };
      })
    );

    return NextResponse.json(foldersWithCounts);
  } catch {
    return NextResponse.json({ error: "Failed to fetch folders" }, { status: 500 });
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
      return NextResponse.json({ error: "Folder name is required" }, { status: 400 });
    }

    const db = getServiceClient();
    const now = new Date().toISOString();

    let parentPath = "/";
    if (parentId) {
      const { data: parent } = await db
        .from("folders")
        .select("path, tenantId")
        .eq("id", parentId)
        .single();
      if (!parent || parent.tenantId !== tenantUser.tenantId) {
        return NextResponse.json({ error: "Parent folder not found" }, { status: 404 });
      }
      parentPath = parent.path === "/" ? "/" : parent.path + "/";
    }

    const path = parentPath + name.trim();

    const { data: folder, error } = await db
      .from("folders")
      .insert({
        id: uuid(),
        tenantId: tenantUser.tenantId,
        name: name.trim(),
        parentId: parentId || null,
        path,
        createdAt: now,
        updatedAt: now,
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: "A folder with this name already exists here" }, { status: 409 });
      }
      throw error;
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "folder.create",
      entityType: "folder",
      entityId: folder.id,
      details: { name: folder.name, path: folder.path },
    });

    return NextResponse.json(folder);
  } catch {
    return NextResponse.json({ error: "Failed to create folder" }, { status: 500 });
  }
}
