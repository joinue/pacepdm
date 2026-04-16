import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { v4 as uuid } from "uuid";
import { logAudit } from "@/lib/audit";
import { z, parseBody, nonEmptyString } from "@/lib/validation";

const LinkPartSchema = z.object({
  partId: nonEmptyString,
  role: z.string().optional(),
});

const UnlinkPartSchema = z.object({ partId: nonEmptyString });

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { fileId } = await params;
    const db = getServiceClient();

    // Verify the file belongs to this tenant before exposing linked parts.
    const { data: fileRecord } = await db
      .from("files")
      .select("id")
      .eq("id", fileId)
      .eq("tenantId", tenantUser.tenantId)
      .single();
    if (!fileRecord) return NextResponse.json({ error: "File not found" }, { status: 404 });

    const { data } = await db
      .from("part_files")
      .select("id, role, isPrimary, createdAt, part:parts!part_files_partId_fkey(id, partNumber, name, lifecycleState, category)")
      .eq("fileId", fileId);

    return NextResponse.json(data || []);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch linked parts";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, LinkPartSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const { fileId } = await params;
    const db = getServiceClient();

    // Verify file belongs to this tenant.
    const { data: fileRecord } = await db
      .from("files")
      .select("id, name, isCheckedOut, checkedOutById")
      .eq("id", fileId)
      .eq("tenantId", tenantUser.tenantId)
      .single();
    if (!fileRecord) return NextResponse.json({ error: "File not found" }, { status: 404 });

    // Checked-out files can only have links changed by the checkout owner (or admins)
    if (fileRecord.isCheckedOut && fileRecord.checkedOutById !== tenantUser.id && !permissions.includes("*")) {
      return NextResponse.json({ error: "File is checked out by another user" }, { status: 423 });
    }

    // Verify part belongs to this tenant.
    const { data: partRecord } = await db
      .from("parts")
      .select("id, partNumber, name")
      .eq("id", body.partId)
      .eq("tenantId", tenantUser.tenantId)
      .single();
    if (!partRecord) return NextResponse.json({ error: "Part not found" }, { status: 404 });

    const { data: pf, error } = await db.from("part_files").insert({
      id: uuid(),
      partId: body.partId,
      fileId,
      role: body.role || "DRAWING",
      isPrimary: false,
      createdAt: new Date().toISOString(),
    }).select().single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: "This file is already linked to this part" }, { status: 409 });
      }
      throw error;
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "part.file_link",
      entityType: "part",
      entityId: body.partId,
      details: { fileId, fileName: fileRecord.name, role: body.role || "DRAWING" },
    });

    return NextResponse.json(pf);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to link part";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.FILE_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, UnlinkPartSchema);
    if (!parsed.ok) return parsed.response;
    const { partId } = parsed.data;

    const { fileId } = await params;
    const db = getServiceClient();

    // Verify file belongs to this tenant and check checkout lock.
    const { data: fileRecord } = await db
      .from("files")
      .select("id, isCheckedOut, checkedOutById")
      .eq("id", fileId)
      .eq("tenantId", tenantUser.tenantId)
      .single();
    if (!fileRecord) return NextResponse.json({ error: "File not found" }, { status: 404 });

    if (fileRecord.isCheckedOut && fileRecord.checkedOutById !== tenantUser.id && !permissions.includes("*")) {
      return NextResponse.json({ error: "File is checked out by another user" }, { status: 423 });
    }

    // Snapshot part name for audit before deleting the link.
    const { data: partRecord } = await db
      .from("parts")
      .select("partNumber, name")
      .eq("id", partId)
      .eq("tenantId", tenantUser.tenantId)
      .single();

    await db.from("part_files").delete().eq("partId", partId).eq("fileId", fileId);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "part.file_unlink",
      entityType: "part",
      entityId: partId,
      details: { fileId, partNumber: partRecord?.partNumber ?? null },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to unlink part";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
