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
  // Grant/revoke per-folder ACL rows. Implicitly held by anyone with ADMIN
  // level on a specific folder, but this permission grants the ability
  // tenant-wide (e.g., for admins who set up the initial access model).
  FOLDER_MANAGE_ACCESS: "folder.manage_access",
  // Bypass the folder access resolver entirely. Used by support/debug roles
  // to see everything regardless of per-folder ACLs. "*" grants this too.
  FOLDER_ACCESS_BYPASS: "folder.bypass_access",
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
  // access). Granted to Admin via "*" and explicitly to Manager, so
  // answering an auditor does not require holding the whole tenant.
  AUDIT_VIEW: "audit.view",
  // Create / revoke public share links for files and BOMs. Gated
  // separately from FILE_VIEW because making content public is a more
  // sensitive action than just reading it — a Viewer role shouldn't be
  // able to mint external-facing URLs even though they can open the
  // file internally.
  SHARE_CREATE: "share.create",
} as const;

export function hasPermission(userPermissions: string[], required: string): boolean {
  if (userPermissions.includes("*")) return true;
  return userPermissions.includes(required);
}

/**
 * Returns the subset of `requested` that the actor doesn't already
 * hold. Used by role-authoring routes to prevent privilege escalation
 * — an admin-of-roles whose own role lacks (say) ADMIN_USERS shouldn't
 * be able to mint a new role that grants ADMIN_USERS and then assign
 * themselves to it. Wildcard "*" can only be granted by someone who
 * already holds "*".
 */
export function permissionsExceedingActor(requested: string[], actor: string[]): string[] {
  if (actor.includes("*")) return [];
  return requested.filter((p) => !actor.includes(p));
}

/**
 * Permissions that are dangerous enough to warrant a warning at the point
 * where someone ticks them. Neither is destructive on its own; both hand the
 * holder authority the rest of the permission set assumes nobody has.
 */
export const SENSITIVE_PERMISSIONS: string[] = [
  // Defeats every per-folder ACL in the tenant at once.
  PERMISSIONS.FOLDER_ACCESS_BYPASS,
  // Lets the holder author roles, which is the lever every other
  // permission is reachable through (bounded by permissionsExceedingActor,
  // but still the widest grant short of "*").
  PERMISSIONS.ADMIN_ROLES,
];

/**
 * Human-readable copy for each permission, used by the roles admin screen.
 *
 * This lives beside the constants rather than in the page because two
 * surfaces need it — the editor's checkbox list and the read-only viewer for
 * system roles — and because a permission whose meaning is only legible to
 * someone reading route code is a permission that gets granted by accident.
 *
 * Keys are the permission values, not the constant names.
 */
export const PERMISSION_INFO: Record<string, { label: string; description: string }> = {
  [PERMISSIONS.FILE_VIEW]: {
    label: "View files",
    description: "Open and download files the user has folder access to.",
  },
  [PERMISSIONS.FILE_UPLOAD]: {
    label: "Upload files",
    description: "Add new files to a folder.",
  },
  [PERMISSIONS.FILE_EDIT]: {
    label: "Edit files, BOMs, parts, and vendors",
    description: "Rename and edit metadata, and create or change BOMs, parts, and vendors.",
  },
  [PERMISSIONS.FILE_DELETE]: {
    label: "Delete files",
    description: "Move files to the recycle bin and restore them.",
  },
  [PERMISSIONS.FILE_CHECKOUT]: {
    label: "Check out files",
    description: "Lock a file for editing so nobody else can change it.",
  },
  [PERMISSIONS.FILE_CHECKIN]: {
    label: "Check in files",
    description: "Upload a new revision and release the lock.",
  },
  [PERMISSIONS.FILE_TRANSITION]: {
    label: "Change lifecycle state",
    description: "Move a file between lifecycle states, subject to the workflow's approvals.",
  },
  [PERMISSIONS.FOLDER_CREATE]: {
    label: "Create folders",
    description: "Add folders anywhere the user can already see.",
  },
  [PERMISSIONS.FOLDER_EDIT]: {
    label: "Edit folders",
    description: "Rename and move folders.",
  },
  [PERMISSIONS.FOLDER_DELETE]: {
    label: "Delete folders",
    description: "Remove folders and everything inside them.",
  },
  [PERMISSIONS.FOLDER_MANAGE_ACCESS]: {
    label: "Manage folder access",
    description: "Grant and revoke per-folder access for other users, tenant-wide.",
  },
  [PERMISSIONS.FOLDER_ACCESS_BYPASS]: {
    label: "Bypass folder access",
    description:
      "See and act on every folder regardless of its access list. Intended for support and debugging.",
  },
  [PERMISSIONS.ECO_CREATE]: {
    label: "Create ECOs",
    description: "Raise a new engineering change order.",
  },
  [PERMISSIONS.ECO_EDIT]: {
    label: "Edit ECOs",
    description: "Change an ECO's contents and submit it for approval.",
  },
  [PERMISSIONS.ECO_APPROVE]: {
    label: "Approve ECOs",
    description:
      "Marks the user as an approver for notification purposes. Who may actually sign a step is decided by the approval workflow and its groups.",
  },
  [PERMISSIONS.ADMIN_USERS]: {
    label: "Manage users",
    description:
      "Invite, deactivate, and reassign users. A user can never assign a role stronger than their own.",
  },
  [PERMISSIONS.ADMIN_ROLES]: {
    label: "Manage roles",
    description: "Create and edit roles, limited to permissions the user already holds.",
  },
  [PERMISSIONS.ADMIN_SETTINGS]: {
    label: "Manage workspace settings",
    description: "Workspace settings, SSO, approval workflows, and approval groups.",
  },
  [PERMISSIONS.ADMIN_LIFECYCLE]: {
    label: "Manage lifecycles",
    description: "Define lifecycle states and the transitions between them.",
  },
  [PERMISSIONS.ADMIN_METADATA]: {
    label: "Manage metadata fields",
    description: "Define the custom fields available on files and parts.",
  },
  [PERMISSIONS.AUDIT_VIEW]: {
    label: "View the audit log",
    description: "Read the tenant-wide audit trail of every change.",
  },
  [PERMISSIONS.SHARE_CREATE]: {
    label: "Create share links",
    description: "Mint public, external-facing URLs for files and BOMs.",
  },
};

const ENGINEER_PERMISSIONS: string[] = [
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
  PERMISSIONS.SHARE_CREATE,
];

export const DEFAULT_ROLES = {
  Admin: {
    description: "Full system access",
    permissions: ["*"],
  },
  /**
   * The rung between Engineer and Admin.
   *
   * Without it the ladder is read → do → own the tenant, and five
   * permissions (delete, folder ACLs, the audit log, approver notification)
   * are reachable only through Admin's "*". A team lead who needs to clear
   * out an obsolete drawing or answer an auditor ends up holding role
   * authoring, SSO, and tenant settings as well.
   *
   * Manager is Engineer plus the things a team lead genuinely owns, and
   * deliberately excludes the four `admin.*` permissions that configure how
   * the workspace itself behaves — a Manager runs the team, an Admin runs
   * the tenant.
   *
   * ADMIN_USERS is included and is safe: role assignment runs the same
   * `permissionsExceedingActor` ceiling as role authoring, so a Manager can
   * invite and deactivate people but cannot promote anyone (including
   * themselves) to Admin.
   */
  Manager: {
    description: "Approve changes, manage team access, and review the audit trail",
    permissions: [
      ...ENGINEER_PERMISSIONS,
      PERMISSIONS.FILE_DELETE,
      PERMISSIONS.FOLDER_DELETE,
      PERMISSIONS.FOLDER_MANAGE_ACCESS,
      PERMISSIONS.ECO_APPROVE,
      PERMISSIONS.AUDIT_VIEW,
      PERMISSIONS.ADMIN_USERS,
    ],
  },
  Engineer: {
    description: "Create, edit, and manage files and ECOs",
    permissions: ENGINEER_PERMISSIONS,
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
  {
    name: "Department",
    fieldType: "SELECT",
    options: ["Engineering", "Manufacturing", "Quality"],
    sortOrder: 12,
  },
  { name: "Notes", fieldType: "TEXT", sortOrder: 13 },
];
