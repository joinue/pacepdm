import { randomUUID } from "node:crypto";
import { withTenant, badRequest, conflict, forbidden, notFound } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { getServiceClient } from "@/lib/db";
import { getFolderAccessScope, canViewFolder, canEditFolder } from "@/lib/folder-access";
import { categoryForExtension } from "@/lib/file-categories";
import { runAfterResponse } from "@/lib/notifications";
import { selectAll, selectAllIn } from "@/lib/paged-query";
import { z, nonEmptyString, optionalString } from "@/lib/validation";
import {
  THUMBNAIL_SOURCE_EXTENSIONS,
  VAULT_BUCKET,
  confirmUploadedObject,
  discardUploadedObject,
  extensionOf,
  generateFileThumbnail,
  readUploadGrant,
  scheduleThumbnail,
} from "@/lib/vault-uploads";

/**
 * How many files one listing may queue for a thumbnail backfill. Each is a
 * download and an extraction after the response; a folder of freshly migrated
 * files catches up over a few views instead of in one burst.
 */
const BACKFILL_PER_LISTING = 3;

const ListQuerySchema = z.object({
  folderId: z.string().optional(),
  checkedOutByMe: z.string().optional(),
});

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

type VersionRow = {
  fileId: string;
  version: number;
  storageKey: string;
  fileSize: number;
  createdAt: string;
  uploadedBy: unknown;
};

/**
 * Two read modes:
 *   * Folder mode (?folderId=) — that folder's files, ordered by name.
 *   * Flat mode (?checkedOutByMe=1) — every file the caller has checked out
 *     across the tenant, oldest checkout first, each carrying its folder so
 *     the list can show a path.
 *
 * Every read is paged. A folder past 1,000 files used to lose the rest from
 * the listing while they still blocked re-upload by name, and past a few
 * hundred files the `.in()` lookups for versions and approvals exceeded the
 * URL limit — with the error discarded, so sizes, uploaders and approval
 * badges went blank (AUD-003 OPS-6).
 */
export const GET = withTenant({ query: ListQuerySchema }, async ({ db, tenantUser, query }) => {
  const checkedOutByMe = query.checkedOutByMe === "1";
  const folderId = query.folderId;
  if (!folderId && !checkedOutByMe) {
    throw badRequest("folderId or a flat-view flag is required");
  }

  const scope = await getFolderAccessScope(tenantUser);

  let files: RawFileRow[];
  if (checkedOutByMe) {
    const rows = await selectAll<RawFileRow>((from, to) =>
      db
        .from("files")
        .select(
          `*, checkedOutBy:tenant_users!files_checkedOutById_fkey(fullName), folder:folders!files_folderId_fkey(id, name, path)`
        )
        .is("deletedAt", null)
        .eq("isCheckedOut", true)
        .eq("checkedOutById", tenantUser.id)
        .order("checkedOutAt", { ascending: true })
        .order("id")
        .range(from, to)
    );
    // A revoked folder never leaks a row, even to the user holding the checkout.
    files = rows.filter((f) => canViewFolder(scope, f.folderId));
  } else {
    // An empty list rather than a 403 keeps a hidden folder's existence hidden.
    if (!canViewFolder(scope, folderId!)) return [];
    files = await selectAll<RawFileRow>((from, to) =>
      db
        .from("files")
        .select(`*, checkedOutBy:tenant_users!files_checkedOutById_fkey(fullName)`)
        .is("deletedAt", null)
        .eq("folderId", folderId!)
        .order("name")
        .order("id")
        .range(from, to)
    );
  }

  const fileIds = files.map((f) => f.id);

  // lint-conventions-allow: child-table-direct-query — `file_versions` has no
  // tenant column; every id here came from the scoped `files` read above,
  // which is what makes this lookup safe.
  const [versions, approvals] = await Promise.all([
    selectAllIn<VersionRow>(fileIds, (chunk, from, to) =>
      db
        .from("file_versions")
        .select(
          "fileId, version, storageKey, fileSize, createdAt, uploadedBy:tenant_users!file_versions_uploadedById_fkey(fullName)"
        )
        .in("fileId", chunk)
        .order("fileId")
        .order("version", { ascending: false })
        .range(from, to)
    ),
    selectAllIn<{ id: string; entityId: string; status: string }>(fileIds, (chunk, from, to) =>
      db
        .from("approval_requests")
        .select("id, entityId, status")
        .eq("entityType", "file")
        .in("entityId", chunk)
        .in("status", ["PENDING", "REJECTED"])
        .order("id")
        .range(from, to)
    ),
  ]);

  // Sorted by version descending within each file, so the first is the latest.
  const versionsByFile = new Map<string, VersionRow[]>();
  for (const v of versions) {
    const list = versionsByFile.get(v.fileId) ?? [];
    list.push(v);
    versionsByFile.set(v.fileId, list);
  }
  const currentVersionOf = (file: RawFileRow) =>
    versionsByFile.get(file.id)?.find((v) => v.version === file.currentVersion);

  // PENDING wins over REJECTED when a file has both.
  const approvalMap = new Map<string, string>();
  for (const req of approvals) {
    const existing = approvalMap.get(req.entityId);
    if (!existing || req.status === "PENDING") approvalMap.set(req.entityId, req.status);
  }

  queueThumbnailBackfill(tenantUser.tenantId, files, currentVersionOf);

  // Thumbnails come from `thumbnailKey`; SVG is served from the file itself,
  // which browsers render. Signed in one call rather than one per file.
  const thumbKeys = new Map<string, string>();
  for (const file of files) {
    if (file.thumbnailKey) {
      thumbKeys.set(file.id, file.thumbnailKey);
    } else if ((file.fileType ?? "").toLowerCase() === "svg") {
      const current = currentVersionOf(file);
      if (current?.storageKey) thumbKeys.set(file.id, current.storageKey);
    }
  }
  const signedByKey = new Map<string, string>();
  if (thumbKeys.size > 0) {
    const { data: signed, error: signError } = await db.storage
      .from(VAULT_BUCKET)
      .createSignedUrls([...new Set(thumbKeys.values())], 300);
    if (signError) {
      console.warn("[files/list] could not sign thumbnail URLs:", signError.message);
    }
    for (const s of signed ?? []) {
      if (s.path && s.signedUrl) signedByKey.set(s.path, s.signedUrl);
    }
  }

  return files.map((file) => {
    const latest = versionsByFile.get(file.id)?.[0];
    const key = thumbKeys.get(file.id);
    return {
      ...file,
      // The response has always carried only the latest version, without the
      // internal fileId/storageKey.
      versions: latest
        ? [
            {
              version: latest.version,
              fileSize: latest.fileSize,
              createdAt: latest.createdAt,
              uploadedBy: latest.uploadedBy,
            },
          ]
        : [],
      approvalStatus: approvalMap.get(file.id) ?? null,
      thumbnailUrl: (key && signedByKey.get(key)) || null,
    };
  });
});

/**
 * Thumbnails for files that have never had one attempted — mostly formats the
 * extractor learned after their upload, like PDFs. This used to download and
 * extract every such file inline, in parallel, inside the listing request; a
 * freshly migrated folder timed out.
 *
 * Now a few per listing are queued after the response. Each is claimed first
 * by stamping `thumbnailAttemptedAt` only where it is still null, so two
 * people opening the same folder do not extract the same file twice. The new
 * thumbnail reaches the screen through the file row's realtime update.
 */
function queueThumbnailBackfill(
  tenantId: string,
  files: RawFileRow[],
  currentVersionOf: (file: RawFileRow) => VersionRow | undefined
) {
  const targets = files
    .filter(
      (f) =>
        !f.thumbnailKey &&
        !f.thumbnailAttemptedAt &&
        THUMBNAIL_SOURCE_EXTENSIONS.has((f.fileType ?? "").toLowerCase())
    )
    .slice(0, BACKFILL_PER_LISTING)
    .map((f) => ({ file: f, current: currentVersionOf(f) }))
    .filter((t): t is { file: RawFileRow; current: VersionRow } => Boolean(t.current));
  if (targets.length === 0) return;

  runAfterResponse(async () => {
    const service = getServiceClient();
    for (const { file, current } of targets) {
      const { data: claimed, error } = await service
        .from("files")
        .update({ thumbnailAttemptedAt: new Date().toISOString() })
        .eq("id", file.id)
        .eq("tenantId", tenantId)
        .is("thumbnailAttemptedAt", null)
        .select("id");
      if (error) {
        console.warn(
          `[files/list] could not claim thumbnail backfill for ${file.id}:`,
          error.message
        );
        continue;
      }
      if (!claimed || claimed.length === 0) continue;
      await generateFileThumbnail(service, {
        tenantId,
        fileId: file.id,
        version: file.currentVersion,
        key: current.storageKey,
        fileName: file.name,
        size: current.fileSize,
      });
    }
  }, `thumbnail backfill for ${targets.length} file(s)`);
}

const CommitBodySchema = z.object({
  uploadToken: nonEmptyString,
  partNumber: optionalString,
  description: optionalString,
  category: optionalString,
  lifecycleState: optionalString,
});

/**
 * Step 3 of uploading a new file: record the object the browser uploaded.
 * Step 1 is POST /api/files/uploads; see lib/vault-uploads.ts.
 *
 * Safe to retry: a commit that already landed returns the file it created.
 */
export const POST = withTenant(
  { permission: PERMISSIONS.FILE_UPLOAD, body: CommitBodySchema },
  async ({ db, tenantUser, permissions, body }) => {
    const grant = readUploadGrant(body.uploadToken, {
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      purpose: "new",
    });

    const { data: alreadyRecorded } = await db
      .from("files")
      .select("*")
      .eq("id", grant.fileId)
      .maybeSingle();
    if (alreadyRecorded) return alreadyRecorded;

    const refuse = async (err: Error): Promise<never> => {
      await discardUploadedObject(db.storage, grant.key);
      throw err;
    };

    // Re-checked: the folder can be deleted, or access revoked, while the
    // upload runs.
    const folderId = grant.folderId!;
    const { data: folder } = await db.from("folders").select("id").eq("id", folderId).maybeSingle();
    if (!folder) return refuse(notFound("Folder not found"));
    const scope = await getFolderAccessScope(tenantUser);
    if (!canViewFolder(scope, folderId)) return refuse(notFound("Folder not found"));
    if (!canEditFolder(scope, folderId)) return refuse(forbidden());

    const { data: existingFile } = await db
      .from("files")
      .select("id, name, currentVersion, isCheckedOut, checkedOutById, isFrozen, lifecycleState")
      .is("deletedAt", null)
      .eq("folderId", folderId)
      .eq("name", grant.name)
      .maybeSingle();
    if (existingFile) {
      return refuse(
        conflict("A file with this name already exists in this folder", {
          code: "DUPLICATE_FILE",
          existingFile,
        })
      );
    }

    try {
      await confirmUploadedObject(db.storage, grant);
    } catch (err) {
      return refuse(err as Error);
    }

    const { data: lifecycle } = await db
      .from("lifecycles")
      .select("id")
      .eq("isDefault", true)
      .maybeSingle();

    const ext = extensionOf(grant.name);
    // Auto-detected from the extension unless the uploader chose a category;
    // lib/file-categories.ts is shared with the dialog so both give the same answer.
    const category = body.category || categoryForExtension(ext) || "OTHER";
    const isAdmin = permissions.includes("*");
    const state = body.lifecycleState && isAdmin ? body.lifecycleState : "WIP";
    const now = new Date().toISOString();

    const { data: dbFile, error: fileError } = await db
      .from("files")
      .insert({
        id: grant.fileId,
        folderId,
        name: grant.name,
        partNumber: body.partNumber ?? null,
        description: body.description ?? null,
        fileType: ext,
        category,
        currentVersion: 1,
        lifecycleId: lifecycle?.id ?? null,
        lifecycleState: state,
        isFrozen: isAdmin && (state === "Released" || state === "Obsolete"),
        isCheckedOut: false,
        createdById: tenantUser.id,
        createdAt: now,
        updatedAt: now,
      })
      .select()
      .single();

    if (fileError) {
      if (fileError.code === "23505") {
        // Either this same commit landed concurrently, or another upload of
        // the same name got in between the check above and the insert.
        const { data: raced } = await db
          .from("files")
          .select("*")
          .eq("id", grant.fileId)
          .maybeSingle();
        if (raced) return raced;
        return refuse(
          conflict("A file with this name already exists in this folder", {
            code: "DUPLICATE_FILE",
          })
        );
      }
      return refuse(new Error(`Could not record the file: ${fileError.message}`));
    }

    // lint-conventions-allow: child-table-direct-query — `grant.fileId` is the
    // file row this request just inserted through the scoped client.
    const { error: versionError } = await db.from("file_versions").insert({
      id: randomUUID(),
      fileId: grant.fileId,
      version: 1,
      storageKey: grant.key,
      fileSize: grant.size,
      uploadedById: tenantUser.id,
      comment: "Initial upload",
      createdAt: now,
    });

    // The file row says `currentVersion: 1`; without its version row it shows
    // in the vault and can never be opened. Remove both rather than leave that.
    if (versionError) {
      const { error: cleanupError } = await db.from("files").delete().eq("id", grant.fileId);
      if (cleanupError) {
        console.error(
          `[files] version row failed for ${grant.fileId} and the file row could not be removed:`,
          cleanupError.message
        );
        throw new Error(`Could not record the initial version: ${versionError.message}`);
      }
      return refuse(new Error(`Could not record the initial version: ${versionError.message}`));
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "file.upload",
      entityType: "file",
      entityId: grant.fileId,
      details: { name: grant.name, version: 1, size: grant.size },
    });

    scheduleThumbnail({
      tenantId: tenantUser.tenantId,
      fileId: grant.fileId,
      version: 1,
      key: grant.key,
      fileName: grant.name,
      size: grant.size,
    });

    return dbFile;
  }
);
