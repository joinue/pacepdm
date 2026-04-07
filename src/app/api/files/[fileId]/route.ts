import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getCurrentTenantUser } from "@/lib/auth";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const tenantUser = await getCurrentTenantUser();
    const { fileId } = await params;
    const db = getServiceClient();

    const { data: file } = await db
      .from("files")
      .select(`
        *,
        folder:folders!files_folderId_fkey(name, path),
        checkedOutBy:tenant_users!files_checkedOutById_fkey(fullName, email)
      `)
      .eq("id", fileId)
      .single();

    if (!file || file.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const [{ data: versions }, { data: metadata }, { data: references }, { data: referencedBy }] =
      await Promise.all([
        db.from("file_versions")
          .select("*, uploadedBy:tenant_users!file_versions_uploadedById_fkey(fullName)")
          .eq("fileId", fileId)
          .order("version", { ascending: false }),
        db.from("metadata_values")
          .select("*, field:metadata_fields!metadata_values_fieldId_fkey(*)")
          .eq("fileId", fileId),
        db.from("file_references")
          .select("*, targetFile:files!file_references_targetFileId_fkey(id, name, partNumber)")
          .eq("sourceFileId", fileId),
        db.from("file_references")
          .select("*, sourceFile:files!file_references_sourceFileId_fkey(id, name, partNumber)")
          .eq("targetFileId", fileId),
      ]);

    return NextResponse.json({
      ...file,
      versions: versions || [],
      metadata: metadata || [],
      references: references || [],
      referencedBy: referencedBy || [],
    });
  } catch {
    return NextResponse.json({ error: "Failed to fetch file" }, { status: 500 });
  }
}
