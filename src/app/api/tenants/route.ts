import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ROLES, DEFAULT_METADATA_FIELDS } from "@/lib/auth";
import { MetadataType } from "@prisma/client";

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
    const { companyName, fullName, email, authUserId } = await request.json();

    if (!companyName || !fullName || !email || !authUserId) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Generate unique slug
    let slug = slugify(companyName);
    const existing = await prisma.tenant.findUnique({ where: { slug } });
    if (existing) {
      slug = `${slug}-${Date.now().toString(36)}`;
    }

    // Create everything in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // 1. Create tenant
      const tenant = await tx.tenant.create({
        data: {
          name: companyName,
          slug,
        },
      });

      // 2. Create default roles
      const roles: Record<string, { id: string }> = {};
      for (const [roleName, roleData] of Object.entries(DEFAULT_ROLES)) {
        const role = await tx.role.create({
          data: {
            tenantId: tenant.id,
            name: roleName,
            description: roleData.description,
            permissions: roleData.permissions,
            isSystem: true,
          },
        });
        roles[roleName] = role;
      }

      // 3. Create the user as Admin
      const tenantUser = await tx.tenantUser.create({
        data: {
          tenantId: tenant.id,
          authUserId,
          email,
          fullName,
          roleId: roles["Admin"].id,
        },
      });

      // 4. Create root folder
      await tx.folder.create({
        data: {
          tenantId: tenant.id,
          name: "Vault",
          path: "/",
        },
      });

      // 5. Create default lifecycle
      const lifecycle = await tx.lifecycle.create({
        data: {
          tenantId: tenant.id,
          name: "Standard",
          isDefault: true,
        },
      });

      const wip = await tx.lifecycleState.create({
        data: {
          lifecycleId: lifecycle.id,
          name: "WIP",
          color: "#F59E0B",
          isInitial: true,
          sortOrder: 0,
        },
      });

      const inReview = await tx.lifecycleState.create({
        data: {
          lifecycleId: lifecycle.id,
          name: "In Review",
          color: "#3B82F6",
          sortOrder: 1,
        },
      });

      const released = await tx.lifecycleState.create({
        data: {
          lifecycleId: lifecycle.id,
          name: "Released",
          color: "#10B981",
          isFinal: false,
          sortOrder: 2,
        },
      });

      const obsolete = await tx.lifecycleState.create({
        data: {
          lifecycleId: lifecycle.id,
          name: "Obsolete",
          color: "#EF4444",
          isFinal: true,
          sortOrder: 3,
        },
      });

      // Transitions
      await tx.lifecycleTransition.createMany({
        data: [
          {
            lifecycleId: lifecycle.id,
            fromStateId: wip.id,
            toStateId: inReview.id,
            name: "Submit for Review",
          },
          {
            lifecycleId: lifecycle.id,
            fromStateId: inReview.id,
            toStateId: wip.id,
            name: "Return to WIP",
          },
          {
            lifecycleId: lifecycle.id,
            fromStateId: inReview.id,
            toStateId: released.id,
            name: "Approve & Release",
            requiresApproval: true,
            approvalRoles: ["Admin", "Engineer"],
          },
          {
            lifecycleId: lifecycle.id,
            fromStateId: released.id,
            toStateId: wip.id,
            name: "Revise",
          },
          {
            lifecycleId: lifecycle.id,
            fromStateId: released.id,
            toStateId: obsolete.id,
            name: "Mark Obsolete",
          },
        ],
      });

      // 6. Create default metadata fields
      for (const field of DEFAULT_METADATA_FIELDS) {
        await tx.metadataField.create({
          data: {
            tenantId: tenant.id,
            name: field.name,
            fieldType: field.fieldType as MetadataType,
            options: "options" in field ? field.options : undefined,
            isSystem: true,
            sortOrder: field.sortOrder,
            appliesTo: [],
          },
        });
      }

      return { tenant, tenantUser };
    });

    return NextResponse.json({
      tenantId: result.tenant.id,
      slug: result.tenant.slug,
    });
  } catch (error) {
    console.error("Tenant creation error:", error);
    return NextResponse.json(
      { error: "Failed to create workspace" },
      { status: 500 }
    );
  }
}
