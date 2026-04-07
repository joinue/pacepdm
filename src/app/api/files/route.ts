import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getCurrentTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { v4 as uuid } from "uuid";

const CATEGORY_MAP: Record<string, string> = {
  sldprt: "PART",
  sldasm: "ASSEMBLY",
  slddrw: "DRAWING",
  pdf: "DOCUMENT",
  doc: "DOCUMENT",
  docx: "DOCUMENT",
  xls: "DOCUMENT",
  xlsx: "DOCUMENT",
};

export async function GET(request: NextRequest) {
  try {
    const tenantUser = await getCurrentTenantUser();
    const { searchParams } = new URL(request.url);
    const folderId = searchParams.get("folderId");

    if (!folderId) {
      return NextResponse.json({ error: "folderId is required" }, { status: 400 });
    }

    const db = getServiceClient();

    const { data: files } = await db
      .from("files")
      .select(`
        *,
        checkedOutBy:tenant_users!files_checkedOutById_fkey(fullName)
      `)
      .eq("tenantId", tenantUser.tenantId)
      .eq("folderId", folderId)
      .order("name");

    // Get latest version for each file
    const filesWithVersions = await Promise.all(
      (files || []).map(async (file) => {
        const { data: versions } = await db
          .from("file_versions")
          .select("version, fileSize, createdAt, uploadedBy:tenant_users!file_versions_uploadedById_fkey(fullName)")
          .eq("fileId", file.id)
          .order("version", { ascending: false })
          .limit(1);
        return { ...file, versions: versions || [] };
      })
    );

    return NextResponse.json(filesWithVersions);
  } catch {
    return NextResponse.json({ error: "Failed to fetch files" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getCurrentTenantUser();
    const permissions = tenantUser.role.permissions as string[];

    if (!hasPermission(permissions, PERMISSIONS.FILE_UPLOAD)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const formData = await request.formData();
    const file = formData.get("file") as globalThis.File | null;
    const folderId = formData.get("folderId") as string;
    const description = formData.get("description") as string | null;
    const partNumber = formData.get("partNumber") as string | null;

    if (!file || !folderId) {
      return NextResponse.json({ error: "File and folderId are required" }, { status: 400 });
    }

    const db = getServiceClient();

    const { data: folder } = await db
      .from("folders")
      .select("id, tenantId")
      .eq("id", folderId)
      .single();
    if (!folder || folder.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "Folder not found" }, { status: 404 });
    }

    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    const category = CATEGORY_MAP[ext] || "OTHER";

    const { data: lifecycle } = await db
      .from("lifecycles")
      .select("id")
      .eq("tenantId", tenantUser.tenantId)
      .eq("isDefault", true)
      .single();

    // Upload to Supabase Storage
    const storageKey = `${tenantUser.tenantId}/${folderId}/${Date.now()}-${file.name}`;
    const supabase = await createServerSupabaseClient();
    const arrayBuffer = await file.arrayBuffer();
    const { error: uploadError } = await supabase.storage
      .from("vault")
      .upload(storageKey, arrayBuffer, { contentType: file.type, upsert: false });

    if (uploadError) {
      console.error("Upload error:", uploadError);
      return NextResponse.json({ error: "Failed to upload file" }, { status: 500 });
    }

    const now = new Date().toISOString();
    const fileId = uuid();

    const { data: dbFile, error: fileError } = await db
      .from("files")
      .insert({
        id: fileId,
        tenantId: tenantUser.tenantId,
        folderId,
        name: file.name,
        partNumber,
        description,
        fileType: ext,
        category,
        currentVersion: 1,
        lifecycleId: lifecycle?.id ?? null,
        lifecycleState: "WIP",
        isCheckedOut: false,
        createdAt: now,
        updatedAt: now,
      })
      .select()
      .single();

    if (fileError) {
      if (fileError.code === "23505") {
        return NextResponse.json({ error: "A file with this name already exists in this folder" }, { status: 409 });
      }
      throw fileError;
    }

    await db.from("file_versions").insert({
      id: uuid(),
      fileId,
      version: 1,
      storageKey,
      fileSize: file.size,
      uploadedById: tenantUser.id,
      comment: "Initial upload",
      createdAt: now,
    });

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "file.upload",
      entityType: "file",
      entityId: fileId,
      details: { name: file.name, version: 1, size: file.size },
    });

    return NextResponse.json(dbFile);
  } catch (error) {
    console.error("File creation error:", error);
    return NextResponse.json({ error: "Failed to create file" }, { status: 500 });
  }
}
