import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { z, parseBody, nonEmptyString } from "@/lib/validation";
import { requireFolderAccess } from "@/lib/folder-access-guards";

const RenameFolderSchema = z.object({ name: nonEmptyString });

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

    const access = await requireFolderAccess(tenantUser, folderId, "view");
    if (!access.ok) return access.response;

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
  } catch (err) {
    console.error("Failed to fetch folder:", err);
    const message = err instanceof Error ? err.message : "Failed to fetch folder";
    return NextResponse.json({ error: message }, { status: 500 });
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

    const parsed = await parseBody(request, RenameFolderSchema);
    if (!parsed.ok) return parsed.response;
    const { name } = parsed.data;

    const db = getServiceClient();

    const { data: folder } = await db.from("folders").select("*").eq("id", folderId).single();
    if (!folder || folder.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "Folder not found" }, { status: 404 });
    }

    const access = await requireFolderAccess(tenantUser, folderId, "edit");
    if (!access.ok) return access.response;

    if (!folder.parentId) {
      return NextResponse.json({ error: "Cannot rename root folder" }, { status: 400 });
    }

    // Build new path
    const parentPath = folder.path.substring(0, folder.path.lastIndexOf(folder.name));
    const newPath = parentPath + name;

    const { error } = await db
      .from("folders")
      .update({ name, path: newPath, updatedAt: new Date().toISOString() })
      .eq("id", folderId);

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json(
          { error: "A folder with this name already exists" },
          { status: 409 }
        );
      }
      throw error;
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "folder.rename",
      entityType: "folder",
      entityId: folderId,
      details: { oldName: folder.name, newName: name },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Failed to rename folder:", err);
    const message = err instanceof Error ? err.message : "Failed to rename folder";
    return NextResponse.json({ error: message }, { status: 500 });
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

    const access = await requireFolderAccess(tenantUser, folderId, "edit");
    if (!access.ok) return access.response;

    if (!folder.parentId) {
      return NextResponse.json({ error: "Cannot delete root folder" }, { status: 400 });
    }

    // Check for contents.
    //
    // Counted WITHOUT the `deletedAt IS NULL` filter this used to carry.
    // `files_folderId_fkey` is ON DELETE RESTRICT, so a trashed file still
    // pins its folder — the folder looked empty to this check, Postgres
    // refused the delete, and (see below) the route reported success anyway.
    const { count: liveFileCount } = await db
      .from("files")
      .select("*", { count: "exact", head: true })
      .eq("folderId", folderId)
      .is("deletedAt", null);
    const { count: allFileCount } = await db
      .from("files")
      .select("*", { count: "exact", head: true })
      .eq("folderId", folderId);
    const { count: childCount } = await db
      .from("folders")
      .select("*", { count: "exact", head: true })
      .eq("parentId", folderId);

    if ((liveFileCount && liveFileCount > 0) || (childCount && childCount > 0)) {
      return NextResponse.json(
        { error: "Folder is not empty. Move or delete contents first." },
        { status: 409 }
      );
    }

    const trashedCount = (allFileCount ?? 0) - (liveFileCount ?? 0);
    if (trashedCount > 0) {
      return NextResponse.json(
        {
          error:
            `This folder still holds ${trashedCount} deleted file${trashedCount === 1 ? "" : "s"} ` +
            `in the trash. Restore or permanently remove ${trashedCount === 1 ? "it" : "them"} ` +
            `before deleting the folder.`,
        },
        { status: 409 }
      );
    }

    // The error was previously discarded. A RESTRICT violation therefore
    // returned success to the caller AND wrote an audit row recording a
    // deletion that never happened — the audit log is what the compliance
    // story rests on, so a false entry in it is worse than the failure.
    const { error: deleteError } = await db.from("folders").delete().eq("id", folderId);
    if (deleteError) {
      return NextResponse.json(
        { error: `Could not delete folder: ${deleteError.message}` },
        { status: 409 }
      );
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "folder.delete",
      entityType: "folder",
      entityId: folderId,
      details: { name: folder.name, path: folder.path },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Failed to delete folder:", err);
    const message = err instanceof Error ? err.message : "Failed to delete folder";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
