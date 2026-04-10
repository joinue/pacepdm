import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { DEFAULT_ROLES, DEFAULT_METADATA_FIELDS } from "@/lib/auth";
import { v4 as uuid } from "uuid";
import { z, parseBody, nonEmptyString } from "@/lib/validation";

const CreateTenantSchema = z.object({
  companyName: nonEmptyString,
  fullName: nonEmptyString,
  email: z.string().email("Must be a valid email"),
  authUserId: nonEmptyString,
});

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

export async function POST(request: NextRequest) {
  try {
    const parsed = await parseBody(request, CreateTenantSchema);
    if (!parsed.ok) return parsed.response;
    const { companyName, fullName, email, authUserId } = parsed.data;

    const db = getServiceClient();
    const now = new Date().toISOString();

    // Generate unique slug
    let slug = slugify(companyName);
    const { data: existing } = await db
      .from("tenants")
      .select("id")
      .eq("slug", slug)
      .single();
    if (existing) {
      slug = `${slug}-${Date.now().toString(36)}`;
    }

    // 1. Create tenant
    const tenantId = uuid();
    const { error: tenantError } = await db.from("tenants").insert({
      id: tenantId,
      name: companyName,
      slug,
      createdAt: now,
      updatedAt: now,
    });
    if (tenantError) throw tenantError;

    // 2. Create default roles
    const roles: Record<string, string> = {};
    for (const [roleName, roleData] of Object.entries(DEFAULT_ROLES)) {
      const roleId = uuid();
      await db.from("roles").insert({
        id: roleId,
        tenantId,
        name: roleName,
        description: roleData.description,
        permissions: roleData.permissions,
        isSystem: true,
        createdAt: now,
        updatedAt: now,
      });
      roles[roleName] = roleId;
    }

    // 3. Create the user as Admin
    await db.from("tenant_users").insert({
      id: uuid(),
      tenantId,
      authUserId,
      email,
      fullName,
      roleId: roles["Admin"],
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    // 4. Create root folder
    await db.from("folders").insert({
      id: uuid(),
      tenantId,
      name: "Vault",
      parentId: null,
      path: "/",
      createdAt: now,
      updatedAt: now,
    });

    // 5. Create default lifecycle
    const lifecycleId = uuid();
    await db.from("lifecycles").insert({
      id: lifecycleId,
      tenantId,
      name: "Standard",
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });

    const wipId = uuid();
    const inReviewId = uuid();
    const releasedId = uuid();
    const obsoleteId = uuid();

    await db.from("lifecycle_states").insert([
      { id: wipId, lifecycleId, name: "WIP", color: "#F59E0B", isInitial: true, isFinal: false, sortOrder: 0 },
      { id: inReviewId, lifecycleId, name: "In Review", color: "#3B82F6", isInitial: false, isFinal: false, sortOrder: 1 },
      { id: releasedId, lifecycleId, name: "Released", color: "#10B981", isInitial: false, isFinal: false, sortOrder: 2 },
      { id: obsoleteId, lifecycleId, name: "Obsolete", color: "#EF4444", isInitial: false, isFinal: true, sortOrder: 3 },
    ]);

    await db.from("lifecycle_transitions").insert([
      { id: uuid(), lifecycleId, fromStateId: wipId, toStateId: inReviewId, name: "Submit for Review", requiresApproval: false },
      { id: uuid(), lifecycleId, fromStateId: inReviewId, toStateId: wipId, name: "Return to WIP", requiresApproval: false },
      { id: uuid(), lifecycleId, fromStateId: inReviewId, toStateId: releasedId, name: "Approve & Release", requiresApproval: true, approvalRoles: ["Admin", "Engineer"] },
      { id: uuid(), lifecycleId, fromStateId: releasedId, toStateId: wipId, name: "Revise", requiresApproval: false },
      { id: uuid(), lifecycleId, fromStateId: releasedId, toStateId: obsoleteId, name: "Mark Obsolete", requiresApproval: false },
    ]);

    // 6. Create default metadata fields
    for (const field of DEFAULT_METADATA_FIELDS) {
      await db.from("metadata_fields").insert({
        id: uuid(),
        tenantId,
        name: field.name,
        fieldType: field.fieldType,
        options: "options" in field ? field.options : null,
        isRequired: false,
        isSystem: true,
        sortOrder: field.sortOrder,
        appliesTo: [],
        createdAt: now,
        updatedAt: now,
      });
    }

    return NextResponse.json({ tenantId, slug });
  } catch (err) {
    console.error("Tenant creation error:", err);
    const message = err instanceof Error ? err.message : "Failed to create workspace";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
