import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

/**
 * How a zip download leaves the browser. It was a GET to a URL carrying a
 * signed token of every file's storage key — ~260 bytes a file — so a
 * selection of about fifty passed the URL and header limits and failed with a
 * 414 or 431. Now the selection goes in a form body and the URL never changes.
 */

const fetchJson = vi.fn();
const toast = vi.hoisted(() => ({
  loading: vi.fn(() => "toast-1"),
  success: vi.fn(),
  message: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  fetchJson: (...args: unknown[]) => fetchJson(...args),
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("sonner", () => ({ toast }));

const { useBulkActions, BULK_ZIP_URL } = await import("./use-bulk-actions");

interface Submitted {
  url: string;
  method: string;
  fields: [string, string][];
  attached: boolean;
}

let submitted: Submitted[];

beforeEach(() => {
  fetchJson.mockReset();
  Object.values(toast).forEach((fn) => fn.mockClear());
  submitted = [];
  // jsdom does not navigate; record what the browser would have sent.
  vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (
    this: HTMLFormElement
  ) {
    const url = new URL(this.action);
    submitted.push({
      url: url.pathname + url.search,
      method: this.method,
      fields: [...new FormData(this).entries()].map(([k, v]) => [k, String(v)]),
      attached: document.body.contains(this),
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mount(selected: string[], currentFolderId = "folder-1") {
  return renderHook(() =>
    useBulkActions({
      selectedFiles: new Set(selected),
      clearSelection: vi.fn(),
      refresh: vi.fn(),
      downloadSingle: vi.fn(),
      currentFolderId,
      rootFolderId: "root",
      removeFile: vi.fn(() => vi.fn()),
    })
  );
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `file-${i}`);

describe("useBulkActions zip download", () => {
  it("downloads 500 files from the same URL as 2, with the selection in the body", async () => {
    for (const count of [2, 500]) {
      fetchJson.mockResolvedValueOnce({ count, totalBytes: count * 1000, skipped: 0 });
      const { result } = mount(ids(count));
      await act(() => result.current.handleBulkDownload());
    }

    expect(submitted.map((s) => s.url)).toEqual([BULK_ZIP_URL, BULK_ZIP_URL]);
    expect(submitted.every((s) => s.method === "post" && s.attached)).toBe(true);
    expect(submitted[1].fields).toHaveLength(500);
    expect(submitted[1].fields[499]).toEqual(["fileId", "file-499"]);
    expect(fetchJson).toHaveBeenCalledWith("/api/files/bulk-download/prepare", {
      method: "POST",
      body: { fileIds: ids(500) },
    });
    // The form is not left lying around in the document.
    expect(document.querySelectorAll("form")).toHaveLength(0);
  });

  it("shows the server's reason and starts nothing when prepare refuses", async () => {
    fetchJson.mockRejectedValueOnce(
      new Error("This selection is 1.2 GB, and one zip can be at most 1 GB.")
    );
    const { result } = mount(ids(3));

    await act(() => result.current.handleBulkDownload());

    expect(toast.error).toHaveBeenCalledWith(
      "This selection is 1.2 GB, and one zip can be at most 1 GB.",
      { id: "toast-1" }
    );
    expect(submitted).toEqual([]);
    expect(result.current.bulkDownloading).toBe(false);
  });

  it("says when some of the selection will be left out", async () => {
    fetchJson.mockResolvedValueOnce({ count: 2, totalBytes: 2000, skipped: 1 });
    const { result } = mount(ids(3));

    await act(() => result.current.handleBulkDownload());

    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("2 files"), {
      id: "toast-1",
      description: "1 selected file is no longer available and will be left out.",
    });
  });

  it("downloads a folder by posting to its own zip URL", async () => {
    fetchJson.mockResolvedValueOnce({ count: 900, totalBytes: 5000, rootName: "Widget-X" });
    const { result } = mount([], "folder-1");

    await act(() => result.current.handleFolderDownload());

    expect(fetchJson).toHaveBeenCalledWith("/api/folders/folder-1/download/prepare", {
      method: "POST",
    });
    expect(submitted).toEqual([
      { url: "/api/folders/folder-1/download/zip", method: "post", fields: [], attached: true },
    ]);
  });
});
