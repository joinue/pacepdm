import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { extractThumbnail } from "@/lib/thumbnail";
import { v4 as uuid } from "uuid";
import { getFolderAccessScope, canViewFolder, canEditFolder } from "@/lib/folder-access";

// File types the thumbnail extractor knows how to process. Files of these
// types that are missing `thumbnailKey` get a just-in-time backfill in the
// list endpoint below — critical for PDFs / SolidWorks files that were
// uploaded before the extractor supported them.
const BACKFILLABLE_EXTS = new Set(["pdf", "png", "jpg", "jpeg", "webp", "gif", "bmp", "sldprt", "sldasm", "slddrw"]);

const CATEGORY_MAP: Record<string, string> = {
  // SolidWorks native
  sldprt: "PART",
  sldasm: "ASSEMBLY",
  slddrw: "DRAWING_2D",
  // 2D drawings
  dxf: "DRAWING_2D",
  dwg: "DRAWING_2D",
  // 3D models / neutral exchange formats
  step: "MODEL_3D",
  stp: "MODEL_3D",
  iges: "MODEL_3D",
  igs: "MODEL_3D",
  stl: "MODEL_3D",
  obj: "MODEL_3D",
  // Documents
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
    const checkedOutByMe = searchParams.get("checkedOutByMe") === "1";

    if (!folderId && !checkedOutByMe) {
      return NextResponse.json(
        { error: "folderId or a flat-view flag is required" },
        { status: 400 }
      );
    }

    const db = getServiceClient();
    const scope = await getFolderAccessScope(tenantUser);

    // Loose shape of the row set the decoration pipeline below consumes.
    // Both read modes return something conforming to this — flat mode
    // additionally includes a joined `folder`, which we just pass through.
    type RawFileRow = {
      id: string;
      folderId: string;
      name: string;
      fileType: string | null;
      currentVersion: number;
      thumbnailKey: string | null;
      thumbnailAttemptedAt: string | null;
      [key: string]: unknown;
    };

    // Two read modes:
    //   * Folder mode (default) — returns that folder's files, ordered by name.
    //   * Flat mode (?checkedOutByMe=1) — returns every file the current user
    //     has checked out across the tenant, oldest-checkout-first. Flat rows
    //     carry their parent folder so the list can render a path, and are
    //     post-filtered by folder access so a revoked folder never leaks a
    //     row through even if the user still technically owns the checkout.
    let files: RawFileRow[] | null;
    if (checkedOutByMe) {
      const { data } = await db
        .from("files")
        .select(
          `*, checkedOutBy:tenant_users!files_checkedOutById_fkey(fullName), folder:folders!files_folderId_fkey(id, name, path)`
        )
        .eq("tenantId", tenantUser.tenantId)
        .is("deletedAt", null)
        .eq("isCheckedOut", true)
        .eq("checkedOutById", tenantUser.id)
        .order("checkedOutAt", { ascending: true });
      files = ((data ?? []) as unknown as RawFileRow[]).filter((f) =>
        canViewFolder(scope, f.folderId)
      );
    } else {
      // Deny at the folder level before touching file rows. Returning an
      // empty list (rather than 403) keeps existence hidden for folders the
      // user shouldn't know about — same convention as the folder listing.
      if (!canViewFolder(scope, folderId!)) {
        return NextResponse.json([]);
      }
      const { data } = await db
        .from("files")
        .select(`
          *,
          checkedOutBy:tenant_users!files_checkedOutById_fkey(fullName)
        `)
        .eq("tenantId", tenantUser.tenantId)
        .is("deletedAt", null)
        .eq("folderId", folderId!)
        .order("name");
      files = (data ?? []) as unknown as RawFileRow[];
    }

    // Get file IDs for batch queries
    const fileIds = (files || []).map((f) => f.id);

    // Batch-fetch all versions for these files in a single query, then group
    // by fileId in memory. This replaces a per-file query (the old N+1) and
    // also serves the image-thumbnail lookup below — both needs come from the
    // same row set, so one round trip covers everything.
    const [allVersionsResult, approvalData] = await Promise.all([
      fileIds.length > 0
        ? db
            .from("file_versions")
            .select("fileId, version, storageKey, fileSize, createdAt, uploadedBy:tenant_users!file_versions_uploadedById_fkey(fullName)")
            .in("fileId", fileIds)
            .order("version", { ascending: false })
        : Promise.resolve({ data: [] }),
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

    // Group versions by fileId. Already sorted by version DESC, so the first
    // entry per file is the latest version.
    const versionsByFile = new Map<string, Array<Record<string, unknown>>>();
    for (const v of (allVersionsResult.data || []) as Array<Record<string, unknown>>) {
      const list = versionsByFile.get(v.fileId as string) || [];
      list.push(v);
      versionsByFile.set(v.fileId as string, list);
    }

    // Preserve the previous response shape: each file gets `versions: [latest]`,
    // omitting the internal fileId/storageKey fields the UI doesn't consume.
    const filesWithVersions = (files || []).map((file) => {
      const latest = versionsByFile.get(file.id)?.[0];
      const versions = latest
        ? [{
            version: latest.version,
            fileSize: latest.fileSize,
            createdAt: latest.createdAt,
            uploadedBy: latest.uploadedBy,
          }]
        : [];
      return { ...file, versions };
    });

    // Build a map of fileId -> approval status
    const approvalMap = new Map<string, string>();
    for (const req of approvalData.data || []) {
      // If multiple requests exist, PENDING takes priority display
      const existing = approvalMap.get(req.entityId);
      if (!existing || req.status === "PENDING") {
        approvalMap.set(req.entityId, req.status);
      }
    }

    // Just-in-time thumbnail backfill. Any file in the list that's
    // missing `thumbnailKey` and has never been attempted gets processed
    // inline: download bytes, extract, upload, stamp the row. This is
    // how PDFs (and any other format that was added to the extractor
    // after their upload) acquire thumbnails retroactively.
    //
    // `thumbnailAttemptedAt` acts as a negative cache: any attempt —
    // success or failure — stamps the timestamp, so files that
    // legitimately have no extractable preview (e.g. SolidWorks files
    // saved without "Save preview picture") don't get reprocessed on
    // every folder view. Users can force a retry via the detail panel's
    // manual "Regenerate thumbnail" button, which ignores the flag.
    //
    // SVG is excluded from the backfill set — browsers render it
    // natively from the raw URL fallback below.
    const backfillTargets = filesWithVersions.filter((file) => {
      if (file.thumbnailKey) return false;
      if (file.thumbnailAttemptedAt) return false;
      const ext = (file.fileType || "").toLowerCase();
      return BACKFILLABLE_EXTS.has(ext);
    });

    if (backfillTargets.length > 0) {
      await Promise.all(
        backfillTargets.map(async (file) => {
          const attemptedAt = new Date().toISOString();
          try {
            const versions = versionsByFile.get(file.id) || [];
            const currentVer = versions.find((v) => v.version === file.currentVersion);
            const storageKey = currentVer?.storageKey as string | undefined;
            if (!storageKey) return;

            const { data: blob } = await db.storage.from("vault").download(storageKey);
            if (!blob) return;

            const arrayBuffer = await blob.arrayBuffer();
            const thumb = await extractThumbnail(arrayBuffer, file.name);

            if (!thumb) {
              // Extraction failed or returned no preview. Stamp the
              // attempt timestamp without a key so we don't retry.
              await db.from("files")
                .update({ thumbnailAttemptedAt: attemptedAt })
                .eq("id", file.id);
              return;
            }

            const newKey = `${tenantUser.tenantId}/thumbnails/${Date.now()}-${file.name}.${thumb.ext}`;
            const { error: upErr } = await db.storage
              .from("vault")
              .upload(newKey, thumb.data, { contentType: thumb.mimeType, upsert: false });
            if (upErr) return;

            await db.from("files")
              .update({ thumbnailKey: newKey, thumbnailAttemptedAt: attemptedAt })
              .eq("id", file.id);
            // Mutate the in-memory object so this same response includes
            // the new thumbnailKey — no second fetch required.
            (file as { thumbnailKey: string | null }).thumbnailKey = newKey;
          } catch (err) {
            console.warn(`[files/list] thumbnail backfill failed for ${file.id}:`, err);
            // Still stamp the attempt so a transient error (network,
            // storage flake) doesn't trap the file in a reprocess loop.
            // The manual regenerate path will retry on demand.
            await db.from("files")
              .update({ thumbnailAttemptedAt: attemptedAt })
              .eq("id", file.id)
              .then(() => undefined, () => undefined);
          }
        })
      );
    }

    // Generate thumbnail URLs for files that have them or are SVG images.
    // SVG is served directly from the raw file (browsers render it); all
    // other raster formats get here via thumbnailKey, either set at upload
    // or by the backfill loop above.
    const SVG_FALLBACK = ["svg"];
    const thumbKeys: { fileId: string; key: string }[] = [];
    for (const file of filesWithVersions) {
      if (file.thumbnailKey) {
        thumbKeys.push({ fileId: file.id, key: file.thumbnailKey });
      } else if (SVG_FALLBACK.includes((file.fileType || "").toLowerCase())) {
        const versions = versionsByFile.get(file.id) || [];
        const currentVer = versions.find((v) => v.version === file.currentVersion);
        if (currentVer?.storageKey) {
          thumbKeys.push({ fileId: file.id, key: currentVer.storageKey as string });
        }
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
  } catch (err) {
    console.error("GET /api/files failed:", err);
    const message = err instanceof Error ? err.message : "Failed to fetch files";
    return NextResponse.json({ error: message }, { status: 500 });
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

    // 5 GB hard cap — prevents storage exhaustion from malicious or
    // accidental uploads. Supabase Storage has its own limits, but we
    // reject early to avoid buffering the entire body.
    const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: "File exceeds the 5 GB size limit" }, { status: 413 });
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

    // Upload requires EDIT on the destination folder. "Can't see it" and
    // "can see but can't write" are distinguished because a user who
    // already knows the folder exists (they navigated into it) deserves
    // a clear 403 rather than a misleading 404.
    const uploadScope = await getFolderAccessScope(tenantUser);
    if (!canViewFolder(uploadScope, folderId)) {
      return NextResponse.json({ error: "Folder not found" }, { status: 404 });
    }
    if (!canEditFolder(uploadScope, folderId)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    const category = requestedCategory || CATEGORY_MAP[ext] || "OTHER";

    // Pre-check for duplicate filename in the same folder. Done before
    // the storage upload so we never create orphan blobs for rejected files.
    const { data: existingFile } = await db
      .from("files")
      .select("id, name, currentVersion, isCheckedOut, checkedOutById, isFrozen, lifecycleState")
      .eq("tenantId", tenantUser.tenantId)
      .eq("folderId", folderId)
      .eq("name", file.name)
      .maybeSingle();

    if (existingFile) {
      return NextResponse.json({
        error: "A file with this name already exists in this folder",
        code: "DUPLICATE_FILE",
        existingFile: {
          id: existingFile.id,
          name: existingFile.name,
          currentVersion: existingFile.currentVersion,
          isCheckedOut: existingFile.isCheckedOut,
          checkedOutById: existingFile.checkedOutById,
          isFrozen: existingFile.isFrozen,
          lifecycleState: existingFile.lifecycleState,
        },
      }, { status: 409 });
    }

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

    // Generate a thumbnail via the format dispatcher (SolidWorks preview
    // extraction, image resize, …). Non-fatal: a missing thumbnail is a UX
    // gap, not a correctness problem, so failures are logged and surfaced
    // as a warning in the response.
    //
    // Clone the buffer before passing to the extractor: the Supabase
    // storage upload above may consume the underlying ArrayBuffer (Node's
    // undici can detach it when streaming the request body), leaving a
    // zero-length buffer for the extractor. A fresh slice guarantees the
    // bytes are still readable.
    let thumbnailKey: string | null = null;
    let thumbnailWarning: string | null = null;
    try {
      const thumbBuffer = arrayBuffer.slice(0);
      const thumb = await extractThumbnail(thumbBuffer, file.name);
      if (thumb) {
        const key = `${tenantUser.tenantId}/thumbnails/${Date.now()}-${file.name}.${thumb.ext}`;
        const { error: thumbUploadError } = await supabase.storage
          .from("vault")
          .upload(key, thumb.data, {
            contentType: thumb.mimeType,
            upsert: false,
          });
        if (thumbUploadError) {
          console.error("Thumbnail storage upload failed:", thumbUploadError);
          thumbnailWarning = "Thumbnail was generated but could not be saved — you can upload one manually from the file detail panel.";
        } else {
          thumbnailKey = key;
        }
      }
    } catch (e) {
      console.error("Thumbnail generation failed:", e);
      thumbnailWarning = "Thumbnail could not be generated — you can upload one manually from the file detail panel.";
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
        createdById: tenantUser.id,
        createdAt: now,
        updatedAt: now,
      })
      .select()
      .single();

    if (fileError) {
      if (fileError.code === "23505") {
        // Race condition: another upload of the same name snuck in between
        // the pre-check and the insert. Return the same enriched shape.
        return NextResponse.json({
          error: "A file with this name already exists in this folder",
          code: "DUPLICATE_FILE",
        }, { status: 409 });
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

    const warnings = thumbnailWarning ? [thumbnailWarning] : undefined;
    return NextResponse.json({ ...dbFile, warnings });
  } catch (error) {
    console.error("File creation error:", error);
    const message = error instanceof Error ? error.message : "Failed to create file";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
