import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { FileCategory } from "@prisma/client";

const CATEGORY_MAP: Record<string, FileCategory> = {
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
      return NextResponse.json(
        { error: "folderId is required" },
        { status: 400 }
      );
    }

    const files = await prisma.file.findMany({
      where: {
        tenantId: tenantUser.tenantId,
        folderId,
      },
      orderBy: { name: "asc" },
      include: {
        checkedOutBy: { select: { fullName: true } },
        versions: {
          orderBy: { version: "desc" },
          take: 1,
          select: {
            version: true,
            fileSize: true,
            createdAt: true,
            uploadedBy: { select: { fullName: true } },
          },
        },
      },
    });

    return NextResponse.json(files);
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch files" },
      { status: 500 }
    );
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
      return NextResponse.json(
        { error: "File and folderId are required" },
        { status: 400 }
      );
    }

    // Verify folder belongs to tenant
    const folder = await prisma.folder.findUnique({
      where: { id: folderId },
    });
    if (!folder || folder.tenantId !== tenantUser.tenantId) {
      return NextResponse.json(
        { error: "Folder not found" },
        { status: 404 }
      );
    }

    // Get file extension and category
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    const category = CATEGORY_MAP[ext] || "OTHER";

    // Get default lifecycle
    const lifecycle = await prisma.lifecycle.findFirst({
      where: { tenantId: tenantUser.tenantId, isDefault: true },
    });

    // Upload to Supabase Storage
    const storageKey = `${tenantUser.tenantId}/${folderId}/${Date.now()}-${file.name}`;
    const supabase = await createServerSupabaseClient();

    const arrayBuffer = await file.arrayBuffer();
    const { error: uploadError } = await supabase.storage
      .from("vault")
      .upload(storageKey, arrayBuffer, {
        contentType: file.type,
        upsert: false,
      });

    if (uploadError) {
      console.error("Upload error:", uploadError);
      return NextResponse.json(
        { error: "Failed to upload file" },
        { status: 500 }
      );
    }

    // Create file + first version in a transaction
    const result = await prisma.$transaction(async (tx) => {
      const dbFile = await tx.file.create({
        data: {
          tenantId: tenantUser.tenantId,
          folderId,
          name: file.name,
          partNumber,
          description,
          fileType: ext,
          category,
          currentVersion: 1,
          lifecycleId: lifecycle?.id,
          lifecycleState: "WIP",
        },
      });

      const version = await tx.fileVersion.create({
        data: {
          fileId: dbFile.id,
          version: 1,
          storageKey,
          fileSize: file.size,
          uploadedById: tenantUser.id,
          comment: "Initial upload",
        },
      });

      return { file: dbFile, version };
    });

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "file.upload",
      entityType: "file",
      entityId: result.file.id,
      details: { name: file.name, version: 1, size: file.size },
    });

    return NextResponse.json(result.file);
  } catch (error: unknown) {
    console.error("File creation error:", error);
    if (
      error instanceof Error &&
      error.message.includes("Unique constraint")
    ) {
      return NextResponse.json(
        { error: "A file with this name already exists in this folder" },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: "Failed to create file" },
      { status: 500 }
    );
  }
}
