import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  canViewFolder,
  canEditFolder,
  canAdminFolder,
  isRestrictedFolder,
  filterViewable,
  getFolderAccessScope,
  openScope,
  type FolderAccessScope,
} from "./folder-access";

const { rpcResult } = vi.hoisted(() => ({
  rpcResult: { current: { data: null, error: null } as unknown },
}));

vi.mock("./db", () => ({
  getServiceClient: () => ({
    rpc: async () => rpcResult.current,
  }),
}));

const tenantUser = {
  id: "user-1",
  tenantId: "tenant-1",
  roleId: "role-1",
  role: { permissions: ["file.view"] },
};

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

// The resolver's error handling is security-critical: an over-broad catch
// here silently drops every folder ACL in the tenant. These pin the two
// cases apart so that can't regress unnoticed.
describe("getFolderAccessScope error handling", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("resolves the scope returned by the RPC", async () => {
    rpcResult.current = {
      data: { restrictedAny: true, allowed: ["f1"], editable: ["f1"] },
      error: null,
    };
    const s = await getFolderAccessScope(tenantUser);
    expect(s.restrictedAny).toBe(true);
    expect(canViewFolder(s, "f1")).toBe(true);
    expect(canViewFolder(s, "f2")).toBe(false);
  });

  it("falls back to an open scope when the RPC does not exist yet", async () => {
    for (const code of ["PGRST202", "42883"]) {
      rpcResult.current = { data: null, error: { code, message: "no function" } };
      const s = await getFolderAccessScope(tenantUser);
      expect(s.restrictedAny).toBe(false);
      expect(canViewFolder(s, "anything")).toBe(true);
    }
  });

  it("fails closed on any other RPC error rather than opening the vault", async () => {
    rpcResult.current = {
      data: null,
      error: { code: "57014", message: "canceling statement due to statement timeout" },
    };
    await expect(getFolderAccessScope(tenantUser)).rejects.toMatchObject({
      code: "57014",
    });
  });
});
