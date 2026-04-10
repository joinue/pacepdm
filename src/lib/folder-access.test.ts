import { describe, it, expect } from "vitest";
import {
  canViewFolder,
  canEditFolder,
  canAdminFolder,
  isRestrictedFolder,
  filterViewable,
  openScope,
  type FolderAccessScope,
} from "./folder-access";

function scope(partial: Partial<FolderAccessScope>): FolderAccessScope {
  return {
    bypass: false,
    restrictedAny: true,
    allowed: new Set(),
    editable: new Set(),
    admin: new Set(),
    denied: new Set(),
    restricted: new Set(),
    ...partial,
  };
}

describe("folder-access predicates", () => {
  describe("public tenant (no ACL rows anywhere)", () => {
    const s = openScope();

    it("allows viewing any folder", () => {
      expect(canViewFolder(s, "any-id")).toBe(true);
      expect(canViewFolder(s, "another")).toBe(true);
    });

    it("allows editing any folder", () => {
      expect(canEditFolder(s, "any-id")).toBe(true);
    });

    it("allows admin on any folder", () => {
      expect(canAdminFolder(s, "any-id")).toBe(true);
    });

    it("marks no folder as restricted", () => {
      expect(isRestrictedFolder(s, "any-id")).toBe(false);
    });
  });

  describe("bypass scope", () => {
    const s = scope({ bypass: true, restrictedAny: true, denied: new Set(["f1"]) });

    it("overrides denied set", () => {
      expect(canViewFolder(s, "f1")).toBe(true);
      expect(canEditFolder(s, "f1")).toBe(true);
      expect(canAdminFolder(s, "f1")).toBe(true);
    });

    it("allows any folder id, even ones not in the sets", () => {
      expect(canViewFolder(s, "unknown")).toBe(true);
    });
  });

  describe("restricted tenant — explicit allow", () => {
    const s = scope({
      allowed: new Set(["f1", "f2"]),
      editable: new Set(["f1"]),
      admin: new Set(),
    });

    it("view requires membership in allowed", () => {
      expect(canViewFolder(s, "f1")).toBe(true);
      expect(canViewFolder(s, "f2")).toBe(true);
      expect(canViewFolder(s, "f3")).toBe(false);
    });

    it("edit requires membership in editable (not just allowed)", () => {
      expect(canEditFolder(s, "f1")).toBe(true);
      expect(canEditFolder(s, "f2")).toBe(false); // view only
    });

    it("admin requires membership in admin set", () => {
      expect(canAdminFolder(s, "f1")).toBe(false);
    });
  });

  describe("DENY wins over allow", () => {
    const s = scope({
      allowed: new Set(["f1"]),
      editable: new Set(["f1"]),
      admin: new Set(["f1"]),
      denied: new Set(["f1"]),
    });

    it("denies view despite being in allowed", () => {
      expect(canViewFolder(s, "f1")).toBe(false);
    });

    it("denies edit despite being in editable", () => {
      expect(canEditFolder(s, "f1")).toBe(false);
    });

    it("denies admin despite being in admin set", () => {
      expect(canAdminFolder(s, "f1")).toBe(false);
    });
  });

  describe("isRestrictedFolder", () => {
    it("returns true only for folders in the restricted set", () => {
      const s = scope({
        restricted: new Set(["f1", "f2"]),
        allowed: new Set(["f1"]),
      });
      expect(isRestrictedFolder(s, "f1")).toBe(true);
      expect(isRestrictedFolder(s, "f2")).toBe(true);
      expect(isRestrictedFolder(s, "f3")).toBe(false);
    });
  });
});

describe("filterViewable", () => {
  it("returns items unchanged in public-tenant fast path", () => {
    const items = [{ folderId: "a" }, { folderId: "b" }];
    const result = filterViewable(openScope(), items, (i) => i.folderId);
    expect(result).toBe(items); // reference equality — no allocation
  });

  it("returns items unchanged when bypass is set", () => {
    const items = [{ folderId: "a" }, { folderId: "b" }];
    const s = scope({ bypass: true });
    expect(filterViewable(s, items, (i) => i.folderId)).toBe(items);
  });

  it("filters out files whose folders are not allowed", () => {
    const s = scope({ allowed: new Set(["a"]) });
    const files = [
      { id: "1", folderId: "a" },
      { id: "2", folderId: "b" },
      { id: "3", folderId: "a" },
    ];
    const result = filterViewable(s, files, (f) => f.folderId);
    expect(result.map((f) => f.id)).toEqual(["1", "3"]);
  });

  it("filters out denied folders even when also in allowed", () => {
    const s = scope({
      allowed: new Set(["a", "b"]),
      denied: new Set(["b"]),
    });
    const files = [
      { id: "1", folderId: "a" },
      { id: "2", folderId: "b" },
    ];
    const result = filterViewable(s, files, (f) => f.folderId);
    expect(result.map((f) => f.id)).toEqual(["1"]);
  });

  it("works for folders keyed by id rather than folderId", () => {
    const s = scope({ allowed: new Set(["f1"]) });
    const folders = [{ id: "f1" }, { id: "f2" }];
    const result = filterViewable(s, folders, (f) => f.id);
    expect(result).toEqual([{ id: "f1" }]);
  });
});
