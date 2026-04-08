import { describe, it, expect } from "vitest";
import { hasPermission, PERMISSIONS, DEFAULT_ROLES } from "./permissions";

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
      "FILE_VIEW", "FILE_UPLOAD", "FILE_EDIT", "FILE_DELETE",
      "FILE_CHECKOUT", "FILE_CHECKIN", "FILE_TRANSITION",
      "FOLDER_CREATE", "FOLDER_EDIT", "FOLDER_DELETE",
      "ECO_CREATE", "ECO_EDIT", "ECO_APPROVE",
      "ADMIN_USERS", "ADMIN_ROLES", "ADMIN_SETTINGS",
      "ADMIN_LIFECYCLE", "ADMIN_METADATA",
    ];
    for (const key of expectedKeys) {
      expect(PERMISSIONS).toHaveProperty(key);
    }
  });

  it("permission values follow domain.action format", () => {
    for (const value of Object.values(PERMISSIONS)) {
      expect(value).toMatch(/^[a-z]+\.[a-z]+$/);
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
});
