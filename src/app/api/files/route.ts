import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { isSolidWorksFile, extractSolidWorksThumbnail } from "@/lib/thumbnail";
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
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
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

    // Get file IDs for batch queries
    const fileIds = (files || []).map((f) => f.id);

    // Get latest version for each file + pending approval requests
    const [filesWithVersions, approvalData] = await Promise.all([
      Promise.all(
        (files || []).map(async (file) => {
          const { data: versions } = await db
            .from("file_versions")
            .select("version, fileSize, createdAt, uploadedBy:tenant_users!file_versions_uploadedById_fkey(fullName)")
            .eq("fileId", file.id)
            .order("version", { ascending: false })
            .limit(1);
          return { ...file, versions: versions || [] };
        })
      ),
      fileIds.length > 0
        ? db
            .from("approval_requests")
            .select("entityId, status")
            .eq("tenantId", tenantUser.tenantId)
            .eq("entityType", "file")
            .in("entityId", fileIds)
            .in("status", ["PENDING", "REJECTED"])
        : Promise.resolve({ data: [] }),
    ]);

    // Build a map of fileId -> approval status
    const approvalMap = new Map<string, string>();
    for (const req of approvalData.data || []) {
      // If multiple requests exist, PENDING takes priority display
      const existing = approvalMap.get(req.entityId);
      if (!existing || req.status === "PENDING") {
        approvalMap.set(req.entityId, req.status);
      }
    }

    // Generate thumbnail URLs for files that have them or are images
    const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];
    const thumbKeys: { fileId: string; key: string }[] = [];
    for (const file of filesWithVersions) {
      if (file.thumbnailKey) {
        thumbKeys.push({ fileId: file.id, key: file.thumbnailKey });
      } else if (IMAGE_EXTS.includes((file.fileType || "").toLowerCase()) && file.versions[0]) {
        // For image files, use the actual file as the thumbnail
        const { data: ver } = await db.from("file_versions").select("storageKey").eq("fileId", file.id).eq("version", file.currentVersion).single();
        if (ver) thumbKeys.push({ fileId: file.id, key: ver.storageKey });
      }
    }

    const thumbUrlMap = new Map<string, string>();
    if (thumbKeys.length > 0) {
      const urls = await Promise.all(
        thumbKeys.map(async ({ fileId: fid, key }) => {
          const { data } = await db.storage.from("vault").createSignedUrl(key, 300);
          return { fid, url: data?.signedUrl || null };
        })
      );
      for (const { fid, url } of urls) {
        if (url) thumbUrlMap.set(fid, url);
      }
    }

    const result = filesWithVersions.map((file) => ({
      ...file,
      approvalStatus: approvalMap.get(file.id) || null,
      thumbnailUrl: thumbUrlMap.get(file.id) || null,
    }));

    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "Failed to fetch files" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const permissions = tenantUser.role.permissions as string[];

    if (!hasPermission(permissions, PERMISSIONS.FILE_UPLOAD)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const formData = await request.formData();
    const file = formData.get("file") as globalThis.File | null;
    const folderId = formData.get("folderId") as string;
    const description = formData.get("description") as string | null;
    const partNumber = formData.get("partNumber") as string | null;
    const requestedState = formData.get("lifecycleState") as string | null;
    const requestedCategory = formData.get("category") as string | null;

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
    const category = requestedCategory || CATEGORY_MAP[ext] || "OTHER";

    const { data: lifecycle } = await db
      .from("lifecycles")
      .select("id")
      .eq("tenantId", tenantUser.tenantId)
      .eq("isDefault", true)
      .single();

    // Upload to Supabase Storage (use service client to bypass storage RLS)
    const storageKey = `${tenantUser.tenantId}/${folderId}/${Date.now()}-${file.name}`;
    const supabase = getServiceClient();
    const arrayBuffer = await file.arrayBuffer();
    const { error: uploadError } = await supabase.storage
      .from("vault")
      .upload(storageKey, arrayBuffer, { contentType: file.type, upsert: false });

    if (uploadError) {
      console.error("Upload error:", uploadError);
      return NextResponse.json({ error: "Failed to upload file" }, { status: 500 });
    }

    // Extract and store thumbnail for SOLIDWORKS files
    let thumbnailKey: string | null = null;
    if (isSolidWorksFile(file.name)) {
      try {
        const thumb = await extractSolidWorksThumbnail(arrayBuffer);
        if (thumb) {
          const thumbExt = thumb.mimeType === "image/jpeg" ? "jpg" : "png";
          thumbnailKey = `${tenantUser.tenantId}/thumbnails/${Date.now()}-${file.name}.${thumbExt}`;
          await supabase.storage
            .from("vault")
            .upload(thumbnailKey, thumb.data, {
              contentType: thumb.mimeType,
              upsert: false,
            });
        }
      } catch (e) {
        console.error("Thumbnail extraction failed:", e);
        // Non-fatal — continue without thumbnail
      }
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
        lifecycleState: (requestedState && permissions.includes("*")) ? requestedState : "WIP",
        isFrozen: (requestedState && permissions.includes("*") && (requestedState === "Released" || requestedState === "Obsolete")) ? true : false,
        isCheckedOut: false,
        thumbnailKey,
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
    const message = error instanceof Error ? error.message : "Failed to create file";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
