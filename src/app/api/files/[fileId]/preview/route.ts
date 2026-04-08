import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";

const PREVIEWABLE_IMAGES = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];
const PREVIEWABLE_TEXT = ["txt", "csv", "md", "json", "xml"];
const PREVIEWABLE_TYPES = ["pdf", ...PREVIEWABLE_IMAGES, ...PREVIEWABLE_TEXT];
const SW_EXTENSIONS = ["sldprt", "sldasm", "slddrw"];

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { fileId } = await params;
    const db = getServiceClient();

    const { data: file } = await db.from("files").select("*").eq("id", fileId).single();
    if (!file || file.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const ext = (file.fileType || file.name?.split(".").pop() || "").toLowerCase();

    // SOLIDWORKS files — use extracted thumbnail if available
    if (SW_EXTENSIONS.includes(ext) && file.thumbnailKey) {
      const { data, error } = await db.storage
        .from("vault")
        .createSignedUrl(file.thumbnailKey, 300);

      if (!error && data) {
        return NextResponse.json({
          canPreview: true,
          previewType: "image",
          fileType: ext,
          url: data.signedUrl,
        });
      }
    }

    if (!PREVIEWABLE_TYPES.includes(ext)) {
      return NextResponse.json({ canPreview: false, fileType: ext });
    }

    // Find the latest version to get the storage key
    const { data: version } = await db
      .from("file_versions")
      .select("*")
      .eq("fileId", fileId)
      .eq("version", file.currentVersion)
      .single();

    if (!version) {
      return NextResponse.json({ canPreview: false, fileType: ext });
    }

    const { data, error } = await db.storage
      .from("vault")
      .createSignedUrl(version.storageKey, 300);

    if (error || !data) {
      console.error("Signed URL error:", error);
      return NextResponse.json({ canPreview: false, fileType: ext });
    }

    let previewType: string;
    if (ext === "pdf") previewType = "pdf";
    else if (PREVIEWABLE_IMAGES.includes(ext)) previewType = "image";
    else if (PREVIEWABLE_TEXT.includes(ext)) previewType = "text";
    else previewType = "download";

    return NextResponse.json({
      canPreview: true,
      previewType,
      fileType: ext,
      url: data.signedUrl,
    });
  } catch (err) {
    console.error("Preview error:", err);
    return NextResponse.json({ error: "Failed to generate preview" }, { status: 500 });
  }
}
