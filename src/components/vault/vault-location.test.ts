import { describe, it, expect } from "vitest";
import {
  initialVaultRequests,
  readVaultLocation,
  searchParamsFrom,
  vaultHref,
} from "./vault-location";

const ROOT = "root";

describe("readVaultLocation", () => {
  it("defaults to the root folder listing", () => {
    expect(readVaultLocation(new URLSearchParams(""), ROOT)).toEqual({
      viewMode: "folder",
      folderId: ROOT,
      fileId: null,
    });
  });

  it("reads a folder, a file, and the older `file` spelling", () => {
    expect(readVaultLocation(new URLSearchParams("folderId=A&fileId=f1"), ROOT)).toEqual({
      viewMode: "folder",
      folderId: "A",
      fileId: "f1",
    });
    expect(readVaultLocation(new URLSearchParams("file=f2"), ROOT).fileId).toBe("f2");
  });

  it("recognises flat views and ignores an unknown one", () => {
    expect(readVaultLocation(new URLSearchParams("view=trash"), ROOT).viewMode).toBe("trash");
    expect(readVaultLocation(new URLSearchParams("view=bogus"), ROOT).viewMode).toBe("folder");
  });
});

describe("vaultHref", () => {
  it("writes what readVaultLocation reads", () => {
    const cases = [
      "",
      "folderId=A",
      "folderId=A&fileId=f1",
      "view=checkouts",
      "view=trash&fileId=f1",
    ];
    for (const query of cases) {
      const loc = readVaultLocation(new URLSearchParams(query), ROOT);
      const href = vaultHref(loc, ROOT);
      const back = readVaultLocation(new URL(href, "http://x").searchParams, ROOT);
      expect(back).toEqual(loc);
    }
  });

  it("leaves the root folder and the folder behind a flat view out of the URL", () => {
    expect(vaultHref({ viewMode: "folder", folderId: ROOT, fileId: null }, ROOT)).toBe("/vault");
    expect(vaultHref({ viewMode: "checkouts", folderId: "A", fileId: null }, ROOT)).toBe(
      "/vault?view=checkouts"
    );
  });
});

describe("searchParamsFrom", () => {
  it("takes the first value of a repeated parameter and skips missing ones", () => {
    const params = searchParamsFrom({ folderId: ["A", "B"], fileId: undefined, view: "trash" });
    expect(params.get("folderId")).toBe("A");
    expect(params.get("fileId")).toBeNull();
    expect(params.get("view")).toBe("trash");
  });
});

/**
 * These are preload hints, and a hint only helps if it is the exact URL the
 * hooks fetch. Keep them in step with `use-vault-contents`, `TrashList` and
 * the detail panel's `refreshFile`.
 */
describe("initialVaultRequests", () => {
  it("names the folder listing for a folder location", () => {
    expect(initialVaultRequests({ viewMode: "folder", folderId: "A", fileId: null })).toEqual([
      "/api/folders?parentId=A",
      "/api/files?folderId=A",
    ]);
  });

  it("names the flat view's own request", () => {
    expect(initialVaultRequests({ viewMode: "checkouts", folderId: "A", fileId: null })).toEqual([
      "/api/files?checkedOutByMe=1",
    ]);
    expect(initialVaultRequests({ viewMode: "trash", folderId: "A", fileId: null })).toEqual([
      "/api/files/deleted?offset=0",
    ]);
  });

  it("adds everything the detail panel loads when a file is open", () => {
    const urls = initialVaultRequests({ viewMode: "folder", folderId: "A", fileId: "f1" });
    expect(urls.slice(2)).toEqual([
      "/api/files/f1",
      "/api/files/f1/where-used",
      "/api/files/f1/revisions",
      "/api/files/f1/parts",
    ]);
  });
});
