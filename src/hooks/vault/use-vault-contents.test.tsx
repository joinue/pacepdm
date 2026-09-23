import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { FileItem, FolderItem } from "@/components/vault/vault-types";

const fetchJson = vi.fn();

vi.mock("@/lib/api-client", () => ({
  fetchJson: (...args: unknown[]) => fetchJson(...args),
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  isAbortError: (e: unknown) => e instanceof Error && e.name === "AbortError",
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const { useVaultContents, clearPrefetchedListings } = await import("./use-vault-contents");

function file(id: string, overrides: Partial<FileItem> = {}): FileItem {
  return {
    id,
    name: `${id}.sldprt`,
    partNumber: null,
    description: null,
    fileType: "sldprt",
    category: "CAD",
    currentVersion: 1,
    lifecycleState: "DRAFT",
    lifecycleId: null,
    revision: "A",
    isFrozen: false,
    isCheckedOut: false,
    checkedOutById: null,
    approvalStatus: null,
    checkedOutBy: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    thumbnailUrl: null,
    versions: [],
    ...overrides,
  };
}

function folder(id: string, name = id): FolderItem {
  return { id, name, parentId: "root", path: `/${name}`, _count: { children: 0, files: 0 } };
}

/** Mounts the hook in folder mode with a known folder + file listing. */
async function mountWithContents(files: FileItem[], folders: FolderItem[] = []) {
  fetchJson.mockImplementation((url: string) =>
    Promise.resolve(url.startsWith("/api/folders") ? folders : files)
  );
  const view = renderHook(() => useVaultContents("folder", "root"));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  return view;
}

beforeEach(() => {
  fetchJson.mockReset();
  // The prefetch cache is module-level; one test's hover must not feed the next.
  clearPrefetchedListings();
});

describe("useVaultContents optimistic edits", () => {
  it("loads folders and files for the current folder", async () => {
    const { result } = await mountWithContents([file("f1")], [folder("d1")]);

    expect(result.current.files.map((f) => f.id)).toEqual(["f1"]);
    expect(result.current.folders.map((f) => f.id)).toEqual(["d1"]);
  });

  describe("patchFile", () => {
    it("applies the patch immediately", async () => {
      const { result } = await mountWithContents([file("f1"), file("f2")]);

      act(() => {
        result.current.patchFile("f1", { isCheckedOut: true, checkedOutById: "u1" });
      });

      expect(result.current.files[0].isCheckedOut).toBe(true);
      expect(result.current.files[0].checkedOutById).toBe("u1");
      // Untouched rows are left alone.
      expect(result.current.files[1].isCheckedOut).toBe(false);
    });

    it("restores the previous values on rollback", async () => {
      const { result } = await mountWithContents([file("f1", { name: "original.sldprt" })]);

      let rollback: () => void = () => {};
      act(() => {
        rollback = result.current.patchFile("f1", { name: "renamed.sldprt" });
      });
      expect(result.current.files[0].name).toBe("renamed.sldprt");

      act(() => rollback());
      expect(result.current.files[0].name).toBe("original.sldprt");
    });

    it("is a no-op for an id that is not in the list", async () => {
      const { result } = await mountWithContents([file("f1")]);

      act(() => {
        const rollback = result.current.patchFile("missing", { name: "x" });
        rollback();
      });

      expect(result.current.files.map((f) => f.id)).toEqual(["f1"]);
    });

    it("rolls back only its own row, leaving a concurrent edit intact", async () => {
      const { result } = await mountWithContents([file("f1"), file("f2")]);

      let rollbackF1: () => void = () => {};
      act(() => {
        rollbackF1 = result.current.patchFile("f1", { name: "a.sldprt" });
      });
      // A second, unrelated edit lands before the first one fails.
      act(() => {
        result.current.patchFile("f2", { name: "b.sldprt" });
      });

      act(() => rollbackF1());

      expect(result.current.files[0].name).toBe("f1.sldprt");
      expect(result.current.files[1].name).toBe("b.sldprt");
    });
  });

  describe("removeFile", () => {
    it("drops the row immediately", async () => {
      const { result } = await mountWithContents([file("f1"), file("f2")]);

      act(() => {
        result.current.removeFile("f1");
      });

      expect(result.current.files.map((f) => f.id)).toEqual(["f2"]);
    });

    it("re-inserts at the original index on rollback", async () => {
      const { result } = await mountWithContents([file("f1"), file("f2"), file("f3")]);

      let rollback: () => void = () => {};
      act(() => {
        rollback = result.current.removeFile("f2");
      });
      expect(result.current.files.map((f) => f.id)).toEqual(["f1", "f3"]);

      act(() => rollback());
      expect(result.current.files.map((f) => f.id)).toEqual(["f1", "f2", "f3"]);
    });

    it("does not duplicate a row a refresh already restored", async () => {
      const { result } = await mountWithContents([file("f1"), file("f2")]);

      let rollback: () => void = () => {};
      act(() => {
        rollback = result.current.removeFile("f1");
      });

      // A refresh lands first and brings the row back.
      await act(async () => {
        await result.current.refresh();
      });
      expect(result.current.files.map((f) => f.id)).toEqual(["f1", "f2"]);

      act(() => rollback());
      expect(result.current.files.map((f) => f.id)).toEqual(["f1", "f2"]);
    });
  });

  describe("folder edits", () => {
    it("patches and rolls back a folder", async () => {
      const { result } = await mountWithContents([], [folder("d1", "Drawings")]);

      let rollback: () => void = () => {};
      act(() => {
        rollback = result.current.patchFolder("d1", { name: "Renamed" });
      });
      expect(result.current.folders[0].name).toBe("Renamed");

      act(() => rollback());
      expect(result.current.folders[0].name).toBe("Drawings");
    });

    it("removes and restores a folder", async () => {
      const { result } = await mountWithContents([], [folder("d1"), folder("d2")]);

      let rollback: () => void = () => {};
      act(() => {
        rollback = result.current.removeFolder("d1");
      });
      expect(result.current.folders.map((f) => f.id)).toEqual(["d2"]);

      act(() => rollback());
      expect(result.current.folders.map((f) => f.id)).toEqual(["d1", "d2"]);
    });
  });

  it("does not fetch a folder listing behind the trash view", async () => {
    fetchJson.mockResolvedValue([]);
    const { result } = renderHook(() => useVaultContents("trash", "root"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchJson).not.toHaveBeenCalled();
  });
});

/**
 * Resting the pointer on a folder starts its listing; the click that follows
 * renders from that request instead of starting another.
 */
describe("useVaultContents prefetch", () => {
  /** Serves each folder its own rows so the test can tell whose listing rendered. */
  function serveByFolder() {
    fetchJson.mockImplementation((url: string) => {
      const id =
        new URL(url, "http://x").searchParams.get("parentId") ??
        new URL(url, "http://x").searchParams.get("folderId");
      return Promise.resolve(
        url.startsWith("/api/folders") ? [folder(`${id}-sub`)] : [file(`${id}-file`)]
      );
    });
  }

  function mountAt(folderId: string) {
    return renderHook(({ id }: { id: string }) => useVaultContents("folder", id), {
      initialProps: { id: folderId },
    });
  }

  it("renders a prefetched folder without fetching it again", async () => {
    serveByFolder();
    const { result, rerender } = mountAt("root");
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchJson).toHaveBeenCalledTimes(2);

    act(() => result.current.prefetchFolder("d1"));
    expect(fetchJson).toHaveBeenCalledTimes(4);

    rerender({ id: "d1" });
    await waitFor(() => expect(result.current.files.map((f) => f.id)).toEqual(["d1-file"]));
    expect(result.current.folders.map((f) => f.id)).toEqual(["d1-sub"]);
    // The navigation used the prefetched listing: no fifth or sixth request.
    expect(fetchJson).toHaveBeenCalledTimes(4);
  });

  it("does not start a second prefetch for a folder already on its way", async () => {
    serveByFolder();
    const { result } = mountAt("root");
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.prefetchFolder("d1");
      result.current.prefetchFolder("d1");
    });
    expect(fetchJson).toHaveBeenCalledTimes(4);
  });

  it("uses a prefetched listing once", async () => {
    serveByFolder();
    const { result, rerender } = mountAt("root");
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.prefetchFolder("d1"));
    rerender({ id: "d1" });
    await waitFor(() => expect(result.current.files.map((f) => f.id)).toEqual(["d1-file"]));
    rerender({ id: "root" });
    await waitFor(() => expect(result.current.files.map((f) => f.id)).toEqual(["root-file"]));

    // Back into d1: the entry was consumed, so this is a real fetch again.
    rerender({ id: "d1" });
    await waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(8));
  });

  it("drops prefetched listings on refresh, since something changed", async () => {
    serveByFolder();
    const { result, rerender } = mountAt("root");
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.prefetchFolder("d1"));
    await act(async () => {
      await result.current.refresh();
    });
    expect(fetchJson).toHaveBeenCalledTimes(6);

    rerender({ id: "d1" });
    await waitFor(() => expect(result.current.files.map((f) => f.id)).toEqual(["d1-file"]));
    // Fetched afresh after the refresh, not served from before it.
    expect(fetchJson).toHaveBeenCalledTimes(8);
  });

  it("reports nothing for a prefetch that fails; the navigation reports its own", async () => {
    serveByFolder();
    const { result, rerender } = mountAt("root");
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchJson.mockRejectedValueOnce(new Error("boom"));
    act(() => result.current.prefetchFolder("d1"));
    await act(async () => {
      await Promise.resolve();
    });

    serveByFolder();
    rerender({ id: "d1" });
    await waitFor(() => expect(result.current.files.map((f) => f.id)).toEqual(["d1-file"]));
  });
});
