import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import {
  resolveToken,
  bumpAccessCount,
  unlockCookieName,
  verifyUnlockCookie,
  logShareAccess,
} from "@/lib/share-tokens";
import { enforceRateLimit, getClientIp } from "@/lib/rate-limit";
import { getReleaseById, type ReleaseManifest } from "@/lib/releases";
import { buildPartPackage, type PartPackageBom } from "@/lib/part-package";

// Type dispatch for the preview path — mirrors the authenticated
// /api/files/[fileId]/preview route. Kept in sync manually; if the
// authenticated list ever drifts, update both.
const PREVIEWABLE_IMAGES = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];
const PREVIEWABLE_TEXT = ["txt", "csv", "md", "json", "xml"];
const PREVIEWABLE_CAD = ["stl", "obj", "step", "stp", "iges", "igs"];
const SW_EXTENSIONS = ["sldprt", "sldasm", "slddrw"];

interface FileContent {
  kind: "file";
  fileName: string;
  canPreview: boolean;
  previewType?: "pdf" | "image" | "text" | "cad";
  fileType?: string;
  url?: string; // Signed storage URL, ~5 min expiry
  allowDownload: boolean;
}

interface BomContent {
  kind: "bom";
  bomName: string;
  revision: string | null;
  status: string | null;
  items: Array<{
    itemNumber: string | null;
    partNumber: string | null;
    name: string | null;
    quantity: number | null;
    unit: string | null;
    material: string | null;
    vendor: string | null;
  }>;
  allowDownload: boolean;
}

interface PartContent {
  kind: "part";
  partNumber: string;
  name: string;
  description: string | null;
  revision: string;
  lifecycleState: string;
  category: string | null;
  material: string | null;
  unit: string | null;
  weight: number | null;
  weightUnit: string | null;
  files: Array<{
    fileName: string;
    fileType: string;
    role: string;
    isPrimary: boolean;
    revision: string;
    version: number;
    /** Not released. Only present when the link opted into WIP. */
    isPreliminary: boolean;
    /** Signed storage URL, ~5 min expiry. Absent if signing failed. */
    url?: string;
  }>;
  boms: PartPackageBom[];
  /** Drives the viewer's package-level warning banner. */
  containsPreliminary: boolean;
  allowDownload: boolean;
}

interface ReleaseContent {
  kind: "release";
  releaseName: string;
  ecoNumber: string;
  releasedAt: string;
  note: string | null;
  manifest: ReleaseManifest;
  allowDownload: boolean;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const limited = enforceRateLimit(request, "share-content");
    if (limited) return limited;

    const { token } = await params;
    const result = await resolveToken(token);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.reason },
        { status: 404, headers: { "X-Robots-Tag": "noindex, nofollow" } }
      );
    }

    const row = result.token;
    const ipAddress = getClientIp(request);
    const userAgent = request.headers.get("user-agent");

    // Password gate: if the token has a password, require the unlock
    // cookie set by /api/public/share/:token/unlock. Note that the cookie
    // is path-scoped to /api/public/share/:token so it only rides on
    // requests to this specific share.
    if (row.passwordHash) {
      const cookie = request.cookies.get(unlockCookieName(token))?.value;
      if (!verifyUnlockCookie(token, cookie)) {
        return NextResponse.json(
          { error: "password_required" },
          { status: 401, headers: { "X-Robots-Tag": "noindex, nofollow" } }
        );
      }
    }

    const db = getServiceClient();

    if (row.resourceType === "file") {
      const { data: file } = await db
        .from("files")
        .select("*")
        .eq("id", row.resourceId)
        .eq("tenantId", row.tenantId)
        .is("deletedAt", null)
        .single();
      if (!file) {
        return NextResponse.json(
          { error: "not_found" },
          { status: 404, headers: { "X-Robots-Tag": "noindex, nofollow" } }
        );
      }

      const ext = (file.fileType || file.name?.split(".").pop() || "").toLowerCase();

      // SolidWorks files: serve the embedded thumbnail (the CAD viewer
      // can't render native SW files in-browser, so "preview" means the
      // extracted bitmap).
      if (SW_EXTENSIONS.includes(ext) && file.thumbnailKey) {
        const { data: thumb } = await db.storage
          .from("vault")
          .createSignedUrl(file.thumbnailKey, 300);
        if (thumb) {
          const payload: FileContent = {
            kind: "file",
            fileName: file.name,
            canPreview: true,
            previewType: "image",
            fileType: ext,
            url: thumb.signedUrl,
            allowDownload: row.allowDownload,
          };
          void bumpAccessCount(row.id);
          // Thumbnail-only branch: no `download` row — the URL points at
          // the thumbnail bitmap, not the underlying SW file.
          logShareAccess({
            tenantId: row.tenantId,
            tokenId: row.id,
            resourceType: row.resourceType,
            resourceId: row.resourceId,
            action: "view-content",
            fileId: file.id,
            ipAddress,
            userAgent,
          });
          return NextResponse.json(payload, {
            headers: { "X-Robots-Tag": "noindex, nofollow" },
          });
        }
      }

      const allPreviewable = [
        "pdf",
        ...PREVIEWABLE_IMAGES,
        ...PREVIEWABLE_TEXT,
        ...PREVIEWABLE_CAD,
      ];
      if (!allPreviewable.includes(ext)) {
        // Unpreviewable file type: still return a response so the
        // viewer can show the download button (if allowed) and metadata.
        const payload: FileContent = {
          kind: "file",
          fileName: file.name,
          canPreview: false,
          fileType: ext,
          allowDownload: row.allowDownload,
        };
        let downloadIssued = false;
        if (row.allowDownload) {
          const { data: version } = await db
            .from("file_versions")
            .select("storageKey")
            .eq("fileId", file.id)
            .eq("version", file.currentVersion)
            .single();
          if (version) {
            const { data: signed } = await db.storage
              .from("vault")
              .createSignedUrl(version.storageKey, 300);
            if (signed) {
              payload.url = signed.signedUrl;
              downloadIssued = true;
            }
          }
        }
        void bumpAccessCount(row.id);
        logShareAccess({
          tenantId: row.tenantId,
          tokenId: row.id,
          resourceType: row.resourceType,
          resourceId: row.resourceId,
          action: "view-content",
          fileId: file.id,
          ipAddress,
          userAgent,
        });
        if (downloadIssued) {
          logShareAccess({
            tenantId: row.tenantId,
            tokenId: row.id,
            resourceType: row.resourceType,
            resourceId: row.resourceId,
            action: "download",
            fileId: file.id,
            ipAddress,
            userAgent,
          });
        }
        return NextResponse.json(payload, {
          headers: { "X-Robots-Tag": "noindex, nofollow" },
        });
      }

      const { data: version } = await db
        .from("file_versions")
        .select("storageKey")
        .eq("fileId", file.id)
        .eq("version", file.currentVersion)
        .single();
      if (!version) {
        return NextResponse.json(
          { error: "version_missing" },
          { status: 404, headers: { "X-Robots-Tag": "noindex, nofollow" } }
        );
      }

      const { data: signed, error: signErr } = await db.storage
        .from("vault")
        .createSignedUrl(version.storageKey, 300);
      if (signErr || !signed) {
        return NextResponse.json(
          { error: "signing_failed" },
          { status: 500, headers: { "X-Robots-Tag": "noindex, nofollow" } }
        );
      }

      let previewType: FileContent["previewType"];
      if (ext === "pdf") previewType = "pdf";
      else if (PREVIEWABLE_IMAGES.includes(ext)) previewType = "image";
      else if (PREVIEWABLE_TEXT.includes(ext)) previewType = "text";
      else previewType = "cad";

      const payload: FileContent = {
        kind: "file",
        fileName: file.name,
        canPreview: true,
        previewType,
        fileType: ext,
        url: signed.signedUrl,
        allowDownload: row.allowDownload,
      };
      void bumpAccessCount(row.id);
      logShareAccess({
        tenantId: row.tenantId,
        tokenId: row.id,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        action: "view-content",
        fileId: file.id,
        ipAddress,
        userAgent,
      });
      // The signed URL is needed to render the preview itself, but it
      // also lets the guest save the file. When `allowDownload` is true
      // we count it as a download opportunity. When false, the UI hides
      // the download button — but a determined viewer can still save
      // the previewed PDF. That's a separate hardening item; this audit
      // only logs `download` when downloads are formally permitted.
      if (row.allowDownload) {
        logShareAccess({
          tenantId: row.tenantId,
          tokenId: row.id,
          resourceType: row.resourceType,
          resourceId: row.resourceId,
          action: "download",
          fileId: file.id,
          ipAddress,
          userAgent,
        });
      }
      return NextResponse.json(payload, {
        headers: { "X-Robots-Tag": "noindex, nofollow" },
      });
    }

    if (row.resourceType === "release") {
      const release = await getReleaseById(db, row.tenantId, row.resourceId);
      if (!release) {
        return NextResponse.json(
          { error: "not_found" },
          { status: 404, headers: { "X-Robots-Tag": "noindex, nofollow" } }
        );
      }
      const payload: ReleaseContent = {
        kind: "release",
        releaseName: release.name,
        ecoNumber: release.ecoNumber,
        releasedAt: release.releasedAt,
        note: release.note,
        manifest: release.manifest,
        allowDownload: row.allowDownload,
      };
      void bumpAccessCount(row.id);
      logShareAccess({
        tenantId: row.tenantId,
        tokenId: row.id,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        action: "view-content",
        ipAddress,
        userAgent,
      });
      return NextResponse.json(payload, {
        headers: { "X-Robots-Tag": "noindex, nofollow" },
      });
    }

    if (row.resourceType === "part") {
      // Part branch: the package is resolved now, not when the link was
      // minted, so a supplier returning after an ECO ships sees the
      // current revision. See src/lib/part-package.ts.
      const pkg = await buildPartPackage(db, row.tenantId, row.resourceId, {
        includeWip: row.includeWip,
      });
      if (!pkg) {
        return NextResponse.json(
          { error: "not_found" },
          { status: 404, headers: { "X-Robots-Tag": "noindex, nofollow" } }
        );
      }

      // Each released file gets its own short-lived signed URL so the
      // viewer can preview and (when permitted) save individual documents
      // without pulling the whole zip.
      const files = await Promise.all(
        pkg.files.map(async (f) => {
          const { data: signed } = await db.storage
            .from("vault")
            .createSignedUrl(f.storageKey, 300);
          return {
            fileName: f.fileName,
            fileType: f.fileType,
            role: f.role,
            isPrimary: f.isPrimary,
            revision: f.revision,
            version: f.version,
            // The guest is told a document is preliminary. They are not told
            // which internal lifecycle state it sits in.
            isPreliminary: f.isPreliminary,
            url: signed?.signedUrl,
          };
        })
      );

      // `filesWithheld` is deliberately not forwarded — a supplier has no
      // business learning that unreleased drawings exist. It is reported
      // to the internal user in the share dialog instead.
      const payload: PartContent = {
        kind: "part",
        partNumber: pkg.partNumber,
        name: pkg.name,
        description: pkg.description,
        revision: pkg.revision,
        lifecycleState: pkg.lifecycleState,
        category: pkg.category,
        material: pkg.material,
        unit: pkg.unit,
        weight: pkg.weight,
        weightUnit: pkg.weightUnit,
        files,
        boms: pkg.boms,
        containsPreliminary: pkg.preliminaryCount > 0,
        allowDownload: row.allowDownload,
      };
      void bumpAccessCount(row.id);
      logShareAccess({
        tenantId: row.tenantId,
        tokenId: row.id,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        action: "view-content",
        ipAddress,
        userAgent,
      });
      return NextResponse.json(payload, {
        headers: { "X-Robots-Tag": "noindex, nofollow" },
      });
    }

    // BOM branch: return a flat list of items for the public table.
    const { data: bom } = await db
      .from("boms")
      .select("id, name, revision, status")
      .eq("id", row.resourceId)
      .eq("tenantId", row.tenantId)
      .is("deletedAt", null)
      .single();
    if (!bom) {
      return NextResponse.json(
        { error: "not_found" },
        { status: 404, headers: { "X-Robots-Tag": "noindex, nofollow" } }
      );
    }

    const { data: items } = await db
      .from("bom_items")
      .select("itemNumber, partNumber, name, quantity, unit, material, vendor, sortOrder")
      .eq("bomId", bom.id)
      .order("sortOrder");

    const payload: BomContent = {
      kind: "bom",
      bomName: bom.name as string,
      revision: (bom.revision as string | null) ?? null,
      status: (bom.status as string | null) ?? null,
      items: (items ?? []).map((i) => ({
        itemNumber: (i.itemNumber as string | null) ?? null,
        partNumber: (i.partNumber as string | null) ?? null,
        name: (i.name as string | null) ?? null,
        quantity: (i.quantity as number | null) ?? null,
        unit: (i.unit as string | null) ?? null,
        material: (i.material as string | null) ?? null,
        vendor: (i.vendor as string | null) ?? null,
      })),
      allowDownload: row.allowDownload,
    };
    void bumpAccessCount(row.id);
    logShareAccess({
      tenantId: row.tenantId,
      tokenId: row.id,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      action: "view-content",
      ipAddress,
      userAgent,
    });
    return NextResponse.json(payload, {
      headers: { "X-Robots-Tag": "noindex, nofollow" },
    });
  } catch (err) {
    console.error("Failed to load shared content:", err);
    const message = err instanceof Error ? err.message : "Failed to load shared content";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
