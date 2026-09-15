import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const nav = vi.hoisted(() => ({
  params: new URLSearchParams(),
  replace: vi.fn(),
}));

/** The address bar changing, as the router would report it. */
function urlBecomes(query: string) {
  nav.params = new URLSearchParams(query);
}

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
  useSearchParams: () => nav.params,
}));

const fetchJson = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({
  fetchJson,
  isAbortError: () => false,
  errorMessage: (e: unknown) => String(e),
}));

import { useVaultNavigation } from "./use-vault-navigation";

const ROOT = "root";

function mount(query = "") {
  nav.params = new URLSearchParams(query);
  return renderHook(() => useVaultNavigation(ROOT));
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchJson.mockResolvedValue({ ancestors: [] });
});

/**
 * The detail panel's unsaved property edits. Every way out of the open file —
 * closing it, a breadcrumb, a flat view — asks the registered guard first.
 */
describe("useVaultNavigation — leaving a file with unsaved edits", () => {
  it("stays on the file when the guard says no", () => {
    const { result } = mount("fileId=f1");
    act(() => result.current.setLeaveGuard(() => false));

    act(() => result.current.selectFile(null));
    act(() => result.current.navigateToFolder({ id: "d1", name: "Docs" }));
    act(() => result.current.enterFlatView("checkouts"));
    act(() => result.current.navigateToBreadcrumb(0));

    expect(result.current.selectedFile).toBe("f1");
    expect(result.current.viewMode).toBe("folder");
    expect(result.current.currentFolderId).toBe(ROOT);
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("leaves when the guard agrees", () => {
    const { result } = mount("fileId=f1");
    const guard = vi.fn(() => true);
    act(() => result.current.setLeaveGuard(guard));
    act(() => result.current.selectFile(null));
    expect(guard).toHaveBeenCalledTimes(1);
    expect(result.current.selectedFile).toBeNull();
  });

  it("does not ask when there is no guard", () => {
    const { result } = mount("fileId=f1");
    act(() => result.current.selectFile(null));
    expect(result.current.selectedFile).toBeNull();
  });

  it("does not ask when the file was deleted", () => {
    const { result } = mount("fileId=f1");
    const guard = vi.fn(() => false);
    act(() => result.current.setLeaveGuard(guard));
    act(() => result.current.selectFile(null, { force: true }));
    expect(guard).not.toHaveBeenCalled();
    expect(result.current.selectedFile).toBeNull();
  });

  it("does not ask when re-selecting the file already open", () => {
    const { result } = mount("fileId=f1");
    const guard = vi.fn(() => false);
    act(() => result.current.setLeaveGuard(guard));
    act(() => result.current.selectFile("f1"));
    expect(guard).not.toHaveBeenCalled();
  });
});

/**
 * Notification links were built as `/vault?file=<id>`, and the vault read only
 * `fileId`, so every "file released" and "checked in" notification opened the
 * vault root. Those links are already stored in notification rows.
 */
describe("useVaultNavigation — the `file` spelling of `fileId`", () => {
  it("opens the file a `?file=` link names", () => {
    expect(mount("file=f1").result.current.selectedFile).toBe("f1");
  });

  it("prefers fileId when a link somehow carries both", () => {
    expect(mount("fileId=f2&file=f1").result.current.selectedFile).toBe("f2");
  });
});

/**
 * State was initialised from the URL once. A navigation that changed only the
 * query string — Cmd-K to a file or folder while already in the vault, a
 * notification, the back button — changed the address bar and nothing else.
 */
describe("useVaultNavigation — following the URL", () => {
  it("opens a file picked from search while in another folder", async () => {
    const { result, rerender } = mount("folderId=A");
    fetchJson.mockResolvedValue({
      ancestors: [
        { id: ROOT, name: "Vault" },
        { id: "B", name: "Brackets" },
      ],
    });

    urlBecomes("folderId=B&fileId=f9");
    rerender();

    await waitFor(() => expect(result.current.selectedFile).toBe("f9"));
    expect(result.current.currentFolderId).toBe("B");
    await waitFor(() => expect(result.current.breadcrumbs.map((b) => b.id)).toEqual([ROOT, "B"]));
    expect(fetchJson).toHaveBeenCalledWith("/api/folders/B", expect.anything());
  });

  it("opens a file from a `?file=` link followed while in the vault", async () => {
    const { result, rerender } = mount();
    urlBecomes("file=f3");
    rerender();
    await waitFor(() => expect(result.current.selectedFile).toBe("f3"));
  });

  it("goes back to the root when the query string is cleared", async () => {
    const { result, rerender } = mount("folderId=A&fileId=f1");
    urlBecomes("");
    rerender();
    await waitFor(() => expect(result.current.currentFolderId).toBe(ROOT));
    expect(result.current.selectedFile).toBeNull();
    expect(result.current.breadcrumbs).toEqual([{ id: ROOT, name: "Vault" }]);
  });

  it("enters a flat view from the URL and keeps the folder to return to", async () => {
    const { result, rerender } = mount("folderId=A");
    urlBecomes("view=checkouts");
    rerender();
    await waitFor(() => expect(result.current.viewMode).toBe("checkouts"));
    expect(result.current.currentFolderId).toBe("A");
  });

  it("does not fight its own navigation, even when an earlier write arrives late", async () => {
    const { result, rerender } = mount();

    act(() => result.current.navigateToFolder({ id: "A", name: "A" }));
    act(() => result.current.navigateToFolder({ id: "B", name: "B" }));
    expect(nav.replace).toHaveBeenLastCalledWith("/vault?folderId=B", { scroll: false });

    // The router reports the first write after the second was made.
    urlBecomes("folderId=A");
    rerender();
    await act(async () => {});
    expect(result.current.currentFolderId).toBe("B");

    urlBecomes("folderId=B");
    rerender();
    await act(async () => {});
    expect(result.current.currentFolderId).toBe("B");
    expect(result.current.breadcrumbs.map((b) => b.id)).toEqual([ROOT, "A", "B"]);
    // Its own navigation needs no breadcrumb lookup.
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("asks before a URL navigation leaves unsaved edits, and puts the URL back if told to stay", async () => {
    const { result, rerender } = mount("fileId=f1");
    const guard = vi.fn(() => false);
    act(() => result.current.setLeaveGuard(guard));

    urlBecomes("fileId=f2");
    rerender();
    await act(async () => {});

    expect(guard).toHaveBeenCalledTimes(1);
    expect(result.current.selectedFile).toBe("f1");
    expect(nav.replace).toHaveBeenLastCalledWith("/vault?fileId=f1", { scroll: false });

    // The restored URL coming back is recognised, not treated as a new navigation.
    urlBecomes("fileId=f1");
    rerender();
    await act(async () => {});
    expect(guard).toHaveBeenCalledTimes(1);
    expect(result.current.selectedFile).toBe("f1");
  });

  it("follows the URL when the guard agrees to leave", async () => {
    const { result, rerender } = mount("fileId=f1");
    act(() => result.current.setLeaveGuard(() => true));
    urlBecomes("fileId=f2");
    rerender();
    await waitFor(() => expect(result.current.selectedFile).toBe("f2"));
  });
});
