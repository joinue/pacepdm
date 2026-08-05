import { describe, it, expect } from "vitest";
import {
  hasPermission,
  permissionsExceedingActor,
  PERMISSIONS,
  PERMISSION_INFO,
  SENSITIVE_PERMISSIONS,
  DEFAULT_ROLES,
} from "./permissions";

describe("hasPermission", () => {
  it("returns true when user has the exact permission", () => {
    expect(hasPermission(["file.view", "file.upload"], "file.view")).toBe(true);
  });

  it("returns false when user lacks the permission", () => {
    expect(hasPermission(["file.view"], "file.upload")).toBe(false);
  });

  it("returns true for wildcard (*) regardless of required permission", () => {
    expect(hasPermission(["*"], "file.delete")).toBe(true);
    expect(hasPermission(["*"], "admin.settings")).toBe(true);
    expect(hasPermission(["*"], "eco.approve")).toBe(true);
  });

  it("returns false for empty permissions array", () => {
    expect(hasPermission([], "file.view")).toBe(false);
  });

  it("wildcard must be exact '*', not a partial match", () => {
    expect(hasPermission(["file.*"], "file.view")).toBe(false);
  });

  it("is case-sensitive", () => {
    expect(hasPermission(["FILE.VIEW"], "file.view")).toBe(false);
  });
});

describe("PERMISSIONS constants", () => {
  it("has all expected permission keys", () => {
    const expectedKeys = [
      "FILE_VIEW",
      "FILE_UPLOAD",
      "FILE_EDIT",
      "FILE_DELETE",
      "FILE_CHECKOUT",
      "FILE_CHECKIN",
      "FILE_TRANSITION",
      "FOLDER_CREATE",
      "FOLDER_EDIT",
      "FOLDER_DELETE",
      "ECO_CREATE",
      "ECO_EDIT",
      "ECO_APPROVE",
      "ADMIN_USERS",
      "ADMIN_ROLES",
      "ADMIN_SETTINGS",
      "ADMIN_LIFECYCLE",
      "ADMIN_METADATA",
    ];
    for (const key of expectedKeys) {
      expect(PERMISSIONS).toHaveProperty(key);
    }
  });

  it("permission values follow domain.action format", () => {
    for (const value of Object.values(PERMISSIONS)) {
      expect(value).toMatch(/^[a-z]+\.[a-z_]+$/);
    }
  });

  it("has no duplicate permission values", () => {
    const values = Object.values(PERMISSIONS);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("DEFAULT_ROLES", () => {
  it("Admin role has wildcard permission", () => {
    expect(DEFAULT_ROLES.Admin.permissions).toEqual(["*"]);
  });

  it("Viewer role has only file.view", () => {
    expect(DEFAULT_ROLES.Viewer.permissions).toEqual([PERMISSIONS.FILE_VIEW]);
  });

  it("Engineer role cannot access admin features", () => {
    const adminPerms = [
      PERMISSIONS.ADMIN_USERS,
      PERMISSIONS.ADMIN_ROLES,
      PERMISSIONS.ADMIN_SETTINGS,
      PERMISSIONS.ADMIN_LIFECYCLE,
      PERMISSIONS.ADMIN_METADATA,
    ];
    for (const perm of adminPerms) {
      expect(DEFAULT_ROLES.Engineer.permissions).not.toContain(perm);
    }
  });

  it("Engineer role can manage files and ECOs", () => {
    const engineerPerms = DEFAULT_ROLES.Engineer.permissions;
    expect(engineerPerms).toContain(PERMISSIONS.FILE_VIEW);
    expect(engineerPerms).toContain(PERMISSIONS.FILE_UPLOAD);
    expect(engineerPerms).toContain(PERMISSIONS.FILE_EDIT);
    expect(engineerPerms).toContain(PERMISSIONS.FILE_CHECKOUT);
    expect(engineerPerms).toContain(PERMISSIONS.FILE_CHECKIN);
    expect(engineerPerms).toContain(PERMISSIONS.FILE_TRANSITION);
    expect(engineerPerms).toContain(PERMISSIONS.ECO_CREATE);
    expect(engineerPerms).toContain(PERMISSIONS.ECO_EDIT);
  });

  it("Engineer cannot delete files", () => {
    expect(DEFAULT_ROLES.Engineer.permissions).not.toContain(PERMISSIONS.FILE_DELETE);
  });

  it("all roles have a description", () => {
    for (const role of Object.values(DEFAULT_ROLES)) {
      expect(role.description).toBeTruthy();
      expect(typeof role.description).toBe("string");
    }
  });

  it("every permission a default role grants is a real permission", () => {
    const known = new Set<string>([...Object.values(PERMISSIONS), "*"]);
    for (const [name, role] of Object.entries(DEFAULT_ROLES)) {
      for (const perm of role.permissions) {
        expect(known.has(perm), `${name} grants unknown permission ${perm}`).toBe(true);
      }
    }
  });
});

describe("Manager role", () => {
  const manager = DEFAULT_ROLES.Manager.permissions;

  it("is a strict superset of Engineer", () => {
    for (const perm of DEFAULT_ROLES.Engineer.permissions) {
      expect(manager).toContain(perm);
    }
    expect(manager.length).toBeGreaterThan(DEFAULT_ROLES.Engineer.permissions.length);
  });

  it("closes the permissions no default role held except through Admin's wildcard", () => {
    // The gap that motivated the role. Each of these was declared in
    // PERMISSIONS and reachable only by holding "*".
    expect(manager).toContain(PERMISSIONS.FILE_DELETE);
    expect(manager).toContain(PERMISSIONS.FOLDER_DELETE);
    expect(manager).toContain(PERMISSIONS.FOLDER_MANAGE_ACCESS);
    expect(manager).toContain(PERMISSIONS.AUDIT_VIEW);
    expect(manager).toContain(PERMISSIONS.ECO_APPROVE);
  });

  it("cannot configure the workspace itself", () => {
    expect(manager).not.toContain("*");
    expect(manager).not.toContain(PERMISSIONS.ADMIN_ROLES);
    expect(manager).not.toContain(PERMISSIONS.ADMIN_SETTINGS);
    expect(manager).not.toContain(PERMISSIONS.ADMIN_LIFECYCLE);
    expect(manager).not.toContain(PERMISSIONS.ADMIN_METADATA);
  });

  it("cannot bypass folder access lists", () => {
    // Manager can grant folder access; seeing through every ACL regardless
    // is a support/debug capability and stays with Admin.
    expect(manager).toContain(PERMISSIONS.FOLDER_MANAGE_ACCESS);
    expect(manager).not.toContain(PERMISSIONS.FOLDER_ACCESS_BYPASS);
  });

  it("manages users but cannot escalate anyone to Admin", () => {
    // ADMIN_USERS is only safe because role assignment runs the same
    // privilege ceiling as role authoring. A Manager assigning the Admin
    // role must be rejected.
    expect(manager).toContain(PERMISSIONS.ADMIN_USERS);
    expect(permissionsExceedingActor(DEFAULT_ROLES.Admin.permissions, manager)).toEqual(["*"]);
  });

  it("can author no role stronger than itself", () => {
    expect(permissionsExceedingActor(manager, manager)).toEqual([]);
    expect(permissionsExceedingActor([PERMISSIONS.ADMIN_SETTINGS], manager)).toEqual([
      PERMISSIONS.ADMIN_SETTINGS,
    ]);
  });

  it("can reach the audit log without holding any other admin permission", () => {
    // Regression guard for the sidebar: the audit log link lives in the
    // Admin nav group, which used to render only for holders of an
    // `admin.*` permission. audit.view alone must be enough.
    expect(hasPermission(manager, PERMISSIONS.AUDIT_VIEW)).toBe(true);
    expect(hasPermission([PERMISSIONS.AUDIT_VIEW], PERMISSIONS.AUDIT_VIEW)).toBe(true);
  });
});

describe("PERMISSION_INFO", () => {
  it("describes every permission", () => {
    for (const value of Object.values(PERMISSIONS)) {
      expect(PERMISSION_INFO[value], `missing copy for ${value}`).toBeDefined();
      expect(PERMISSION_INFO[value].label).toBeTruthy();
      expect(PERMISSION_INFO[value].description).toBeTruthy();
    }
  });

  it("describes nothing that is not a permission", () => {
    const known = new Set<string>(Object.values(PERMISSIONS));
    for (const key of Object.keys(PERMISSION_INFO)) {
      expect(known.has(key), `${key} is not a permission`).toBe(true);
    }
  });

  it("marks only real permissions as sensitive", () => {
    const known = new Set<string>(Object.values(PERMISSIONS));
    for (const perm of SENSITIVE_PERMISSIONS) {
      expect(known.has(perm)).toBe(true);
    }
    expect(SENSITIVE_PERMISSIONS).toContain(PERMISSIONS.FOLDER_ACCESS_BYPASS);
  });
});
