import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchJson = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, fetchJson };
});

import { ApiError } from "@/lib/api-client";
import { duplicateOf, ensureFolderPath, storageUploadError } from "./vault-upload-client";

beforeEach(() => {
  fetchJson.mockReset();
});

describe("storageUploadError", () => {
  const file = new File([new Uint8Array(10)], "Housing.SLDASM");

  it("explains the storage size limit instead of repeating storage's message", () => {
    const err = storageUploadError(
      413,
      JSON.stringify({
        statusCode: "413",
        message: "The object exceeded the maximum allowed size",
      }),
      file
    );
    expect(err.message).toMatch(/larger than the workspace's storage upload limit/);
    expect(err.message).toContain("Housing.SLDASM");
  });

  it("recognises the size limit by its message when the status differs", () => {
    const err = storageUploadError(
      400,
      '{"message":"The object exceeded the maximum allowed size"}',
      file
    );
    expect(err.status).toBe(413);
  });

  it("passes other refusals through with the file's name", () => {
    expect(storageUploadError(403, '{"message":"invalid signature"}', file).message).toBe(
      'Storage refused "Housing.SLDASM": invalid signature (status 403)'
    );
  });
});

describe("duplicateOf", () => {
  it("returns the existing file from a DUPLICATE_FILE refusal", () => {
    const existingFile = { id: "f-1", name: "a.pdf", currentVersion: 2 };
    const err = new ApiError("exists", 409, {
      error: "exists",
      details: { code: "DUPLICATE_FILE", existingFile },
    });
    expect(duplicateOf(err)).toEqual(existingFile);
  });

  it("ignores any other conflict", () => {
    expect(duplicateOf(new ApiError("frozen", 409, { error: "frozen" }))).toBeNull();
    expect(duplicateOf(new Error("x"))).toBeNull();
  });
});

/**
 * A dropped folder recreates its subfolders under the current folder. Ten
 * files from the same subfolder must create it once, not race to create it
 * ten times and fail nine.
 */
describe("ensureFolderPath", () => {
  it("creates each folder once for files that share it", async () => {
    let n = 0;
    fetchJson.mockImplementation(async (url: string, init?: { body?: { name: string } }) => {
      if (url === "/api/folders" && init?.body)
        return { id: `${init.body.name}-${++n}`, name: init.body.name };
      throw new Error(`unexpected ${url}`);
    });
    const cache = new Map<string, Promise<string>>();

    const ids = await Promise.all(
      Array.from({ length: 10 }, () => ensureFolderPath("root", ["Assy", "Parts"], cache))
    );

    expect(new Set(ids)).toEqual(new Set(["Parts-2"]));
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });

  it("uses the folder that already exists when creating it conflicts", async () => {
    fetchJson.mockImplementation(async (url: string) => {
      if (url === "/api/folders")
        throw new ApiError("A folder with this name already exists here", 409);
      if (url === "/api/folders?parentId=root") return [{ id: "existing-assy", name: "Assy" }];
      throw new Error(`unexpected ${url}`);
    });

    expect(await ensureFolderPath("root", ["Assy"], new Map())).toBe("existing-assy");
  });

  it("reports a refusal other than a conflict", async () => {
    fetchJson.mockRejectedValue(new ApiError("Forbidden", 403));
    await expect(ensureFolderPath("root", ["Assy"], new Map())).rejects.toThrow("Forbidden");
  });

  it("returns the root for a file with no subfolder", async () => {
    expect(await ensureFolderPath("root", [], new Map())).toBe("root");
    expect(fetchJson).not.toHaveBeenCalled();
  });
});
