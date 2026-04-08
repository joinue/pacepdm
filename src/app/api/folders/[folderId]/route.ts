import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// Get folder with ancestor chain (for deep-linking breadcrumbs)
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ folderId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { folderId } = await params;
    const db = getServiceClient();

    const { data: folder } = await db
      .from("folders")
      .select("id, name, parentId, path, tenantId")
      .eq("id", folderId)
      .single();

    if (!folder || folder.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "Folder not found" }, { status: 404 });
    }

    // Walk up the tree to build ancestor chain
    const ancestors: { id: string; name: string }[] = [];
    let current = folder;
    while (current.parentId) {
      const { data: parent } = await db
        .from("folders")
        .select("id, name, parentId, path, tenantId")
        .eq("id", current.parentId)
        .single();
      if (!parent) break;
      ancestors.unshift({ id: parent.id, name: parent.parentId ? parent.name : "Vault" });
      current = parent;
    }
    ancestors.push({ id: folder.id, name: folder.name });

    return NextResponse.json({ ...folder, ancestors });
  } catch {
    return NextResponse.json({ error: "Failed to fetch folder" }, { status: 500 });
  }
}

// Rename folder
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ folderId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    const { folderId } = await params;

    if (!hasPermission(permissions, PERMISSIONS.FOLDER_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const db = getServiceClient();
    const { name } = await request.json();

    if (!name?.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const { data: folder } = await db.from("folders").select("*").eq("id", folderId).single();
    if (!folder || folder.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "Folder not found" }, { status: 404 });
    }

    if (!folder.parentId) {
      return NextResponse.json({ error: "Cannot rename root folder" }, { status: 400 });
    }

    // Build new path
    const parentPath = folder.path.substring(0, folder.path.lastIndexOf(folder.name));
    const newPath = parentPath + name.trim();

    const { error } = await db.from("folders")
      .update({ name: name.trim(), path: newPath, updatedAt: new Date().toISOString() })
      .eq("id", folderId);

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: "A folder with this name already exists" }, { status: 409 });
      }
      throw error;
    }

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "folder.rename", entityType: "folder", entityId: folderId,
      details: { oldName: folder.name, newName: name.trim() },
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to rename folder" }, { status: 500 });
  }
}

// Delete folder
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ folderId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    const { folderId } = await params;

    if (!hasPermission(permissions, PERMISSIONS.FOLDER_DELETE)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const db = getServiceClient();

    const { data: folder } = await db.from("folders").select("*").eq("id", folderId).single();
    if (!folder || folder.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "Folder not found" }, { status: 404 });
    }

    if (!folder.parentId) {
      return NextResponse.json({ error: "Cannot delete root folder" }, { status: 400 });
    }

    // Check for contents
    const { count: fileCount } = await db.from("files").select("*", { count: "exact", head: true }).eq("folderId", folderId);
    const { count: childCount } = await db.from("folders").select("*", { count: "exact", head: true }).eq("parentId", folderId);

    if ((fileCount && fileCount > 0) || (childCount && childCount > 0)) {
      return NextResponse.json({ error: "Folder is not empty. Move or delete contents first." }, { status: 409 });
    }

    await db.from("folders").delete().eq("id", folderId);

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "folder.delete", entityType: "folder", entityId: folderId,
      details: { name: folder.name, path: folder.path },
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete folder" }, { status: 500 });
  }
}
