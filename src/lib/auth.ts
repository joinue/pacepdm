import { createServerSupabaseClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";

export async function getSession() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export async function requireAuth() {
  const user = await getSession();
  if (!user) redirect("/login");
  return user;
}

export async function getCurrentTenantUser() {
  const user = await requireAuth();

  const tenantUser = await prisma.tenantUser.findFirst({
    where: { authUserId: user.id, isActive: true },
    include: {
      tenant: true,
      role: true,
    },
  });

  if (!tenantUser) redirect("/onboarding");
  return tenantUser;
}

export function hasPermission(
  userPermissions: string[],
  required: string
): boolean {
  if (userPermissions.includes("*")) return true;
  return userPermissions.includes(required);
}

export const PERMISSIONS = {
  // Files
  FILE_VIEW: "file.view",
  FILE_UPLOAD: "file.upload",
  FILE_EDIT: "file.edit",
  FILE_DELETE: "file.delete",
  FILE_CHECKOUT: "file.checkout",
  FILE_CHECKIN: "file.checkin",
  FILE_TRANSITION: "file.transition",

  // Folders
  FOLDER_CREATE: "folder.create",
  FOLDER_EDIT: "folder.edit",
  FOLDER_DELETE: "folder.delete",

  // ECOs
  ECO_CREATE: "eco.create",
  ECO_EDIT: "eco.edit",
  ECO_APPROVE: "eco.approve",

  // Admin
  ADMIN_USERS: "admin.users",
  ADMIN_ROLES: "admin.roles",
  ADMIN_SETTINGS: "admin.settings",
  ADMIN_LIFECYCLE: "admin.lifecycle",
  ADMIN_METADATA: "admin.metadata",
} as const;

export const DEFAULT_ROLES = {
  Admin: {
    description: "Full system access",
    permissions: ["*"],
  },
  Engineer: {
    description: "Create, edit, and manage files and ECOs",
    permissions: [
      PERMISSIONS.FILE_VIEW,
      PERMISSIONS.FILE_UPLOAD,
      PERMISSIONS.FILE_EDIT,
      PERMISSIONS.FILE_CHECKOUT,
      PERMISSIONS.FILE_CHECKIN,
      PERMISSIONS.FILE_TRANSITION,
      PERMISSIONS.FOLDER_CREATE,
      PERMISSIONS.FOLDER_EDIT,
      PERMISSIONS.ECO_CREATE,
      PERMISSIONS.ECO_EDIT,
    ],
  },
  Viewer: {
    description: "Read-only access to files and folders",
    permissions: [PERMISSIONS.FILE_VIEW],
  },
};

export const DEFAULT_METADATA_FIELDS = [
  { name: "Material", fieldType: "TEXT" as const, sortOrder: 1 },
  { name: "Weight", fieldType: "NUMBER" as const, sortOrder: 2 },
  { name: "Surface Finish", fieldType: "TEXT" as const, sortOrder: 3 },
  { name: "Tolerance Class", fieldType: "TEXT" as const, sortOrder: 4 },
  { name: "Drawing Number", fieldType: "TEXT" as const, sortOrder: 5 },
  {
    name: "Make/Buy",
    fieldType: "SELECT" as const,
    options: ["Manufactured", "Purchased", "Modified Off-Shelf"],
    sortOrder: 6,
  },
  { name: "Vendor", fieldType: "TEXT" as const, sortOrder: 7 },
  { name: "Vendor Part Number", fieldType: "TEXT" as const, sortOrder: 8 },
  { name: "Unit Cost", fieldType: "NUMBER" as const, sortOrder: 9 },
  { name: "Lead Time (days)", fieldType: "NUMBER" as const, sortOrder: 10 },
  { name: "Project", fieldType: "TEXT" as const, sortOrder: 11 },
  { name: "Department", fieldType: "SELECT" as const, options: ["Engineering", "Manufacturing", "Quality"], sortOrder: 12 },
  { name: "Notes", fieldType: "TEXT" as const, sortOrder: 13 },
];
