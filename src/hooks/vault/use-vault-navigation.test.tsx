import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const nav = vi.hoisted(() => ({
  params: new URLSearchParams(),
  replace: vi.fn(),
}));

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
