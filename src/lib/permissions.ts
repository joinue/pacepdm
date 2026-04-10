// Shared permission constants — safe to import from client or server components

export const PERMISSIONS = {
  FILE_VIEW: "file.view",
  FILE_UPLOAD: "file.upload",
  FILE_EDIT: "file.edit",
  FILE_DELETE: "file.delete",
  FILE_CHECKOUT: "file.checkout",
  FILE_CHECKIN: "file.checkin",
  FILE_TRANSITION: "file.transition",
  FOLDER_CREATE: "folder.create",
  FOLDER_EDIT: "folder.edit",
  FOLDER_DELETE: "folder.delete",
  ECO_CREATE: "eco.create",
  ECO_EDIT: "eco.edit",
  ECO_APPROVE: "eco.approve",
  ADMIN_USERS: "admin.users",
  ADMIN_ROLES: "admin.roles",
  ADMIN_SETTINGS: "admin.settings",
  ADMIN_LIFECYCLE: "admin.lifecycle",
  ADMIN_METADATA: "admin.metadata",
  // Audit log access. Tenant-wide audit data is sensitive (privacy +
  // compliance — 21 CFR Part 11, ISO 9001, SOC 2 all expect controlled
  // access). Granted to Admin via "*"; can be granted explicitly to a
  // future Compliance/Quality role without conferring other admin powers.
  AUDIT_VIEW: "audit.view",
} as const;

export function hasPermission(
  userPermissions: string[],
  required: string
): boolean {
  if (userPermissions.includes("*")) return true;
  return userPermissions.includes(required);
}

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
  { name: "Material", fieldType: "TEXT", sortOrder: 1 },
  { name: "Weight", fieldType: "NUMBER", sortOrder: 2 },
  { name: "Surface Finish", fieldType: "TEXT", sortOrder: 3 },
  { name: "Tolerance Class", fieldType: "TEXT", sortOrder: 4 },
  { name: "Drawing Number", fieldType: "TEXT", sortOrder: 5 },
  {
    name: "Make/Buy",
    fieldType: "SELECT",
    options: ["Manufactured", "Purchased", "Modified Off-Shelf"],
    sortOrder: 6,
  },
  { name: "Vendor", fieldType: "TEXT", sortOrder: 7 },
  { name: "Vendor Part Number", fieldType: "TEXT", sortOrder: 8 },
  { name: "Unit Cost", fieldType: "NUMBER", sortOrder: 9 },
  { name: "Lead Time (days)", fieldType: "NUMBER", sortOrder: 10 },
  { name: "Project", fieldType: "TEXT", sortOrder: 11 },
  { name: "Department", fieldType: "SELECT", options: ["Engineering", "Manufacturing", "Quality"], sortOrder: 12 },
  { name: "Notes", fieldType: "TEXT", sortOrder: 13 },
];
