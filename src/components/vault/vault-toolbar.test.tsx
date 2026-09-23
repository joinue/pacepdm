import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VaultToolbar } from "./vault-toolbar";
import type { VaultBrowserState } from "@/hooks/use-vault-browser";

/**
 * The vault's heading is its breadcrumb trail, and the trail has one shape:
 * the vault, the folders in between folded into a menu, the parent, then the
 * current folder as the heading. What is tested here is that shape, that the
 * folded levels stay reachable, and that ancestor crumbs are real links.
 */

vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    permissions: ["*"],
    can: () => true,
    canAny: () => true,
    canAll: () => true,
  }),
}));

type VaultOverrides = Partial<Record<keyof VaultBrowserState, unknown>>;

function renderToolbar(overrides: VaultOverrides = {}) {
  const vault = {
    viewMode: "folder",
    breadcrumbs: [{ id: "root", name: "Vault" }],
    currentFolderId: "root",
    selectedFile: null,
    selectedFiles: new Set<string>(),
    searchQuery: "",
    filterState: "all",
    lifecycleStates: [],
    dropTargetId: null,
    canDownloadFolder: false,
    folderDownloading: false,
    bulkDownloading: false,

    navigateToBreadcrumb: vi.fn(),
    prefetchFolder: vi.fn(),
    setSearchQuery: vi.fn(),
    setFilterState: vi.fn(),
    enterFlatView: vi.fn(),
    exitFlatView: vi.fn(),
    setShowCreateFolder: vi.fn(),
    setShowUpload: vi.fn(),
    setShowBulkDeleteConfirm: vi.fn(),
    handleFolderDownload: vi.fn(),
    handleBulkDownload: vi.fn(),
    handleDragOver: vi.fn(),
    handleDragLeave: vi.fn(),
    handleDrop: vi.fn(),
    ...overrides,
  } as unknown as VaultBrowserState;
  render(<VaultToolbar vault={vault} />);
  return vault;
}

const crumb = (id: string, name = id) => ({ id, name });
const ROOT = crumb("root", "Vault");

describe("VaultBreadcrumbs — shape of the trail", () => {
  it("is the word Vault at the root, as the heading", () => {
    renderToolbar();
    expect(screen.getByRole("heading", { level: 1, name: "Vault" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Vault" })).not.toBeInTheDocument();
  });

  it("becomes the vault icon, linked, one level down", () => {
    renderToolbar({ breadcrumbs: [ROOT, crumb("A", "Assemblies")], currentFolderId: "A" });
    expect(screen.getByRole("heading", { level: 1, name: "Assemblies" })).toBeInTheDocument();
    const vault = screen.getByRole("link", { name: "Vault" });
    expect(vault).toHaveAttribute("href", "/vault");
    // Nothing between the vault and the current folder, so nothing to fold.
    expect(screen.queryByRole("button", { name: /more folder/ })).not.toBeInTheDocument();
  });

  it("shows the vault, the parent and the current folder when three deep", () => {
    renderToolbar({ breadcrumbs: [ROOT, crumb("A"), crumb("B")], currentFolderId: "B" });
    expect(screen.getByRole("link", { name: "Vault" })).toHaveAttribute("href", "/vault");
    expect(screen.getByRole("link", { name: "A" })).toHaveAttribute("href", "/vault?folderId=A");
    expect(screen.getByRole("heading", { level: 1, name: "B" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /more folder/ })).not.toBeInTheDocument();
  });

  it("folds the levels between the vault and the parent into a menu", async () => {
    const user = userEvent.setup();
    const vault = renderToolbar({
      breadcrumbs: [ROOT, crumb("A"), crumb("B"), crumb("C"), crumb("D")],
      currentFolderId: "D",
    });

    // Vault, "…", parent, current. The folded levels are not on the trail.
    expect(screen.getByRole("link", { name: "Vault" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "C" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "D" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "A" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "B" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "2 more folders" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["A", "B"]);

    await user.click(items[1]);
    // B is the third crumb: index 2.
    expect(vault.navigateToBreadcrumb).toHaveBeenCalledWith(2);
  });
});

describe("VaultBreadcrumbs — ancestor crumbs", () => {
  it("navigates in place on a plain click", async () => {
    const user = userEvent.setup();
    const vault = renderToolbar({
      breadcrumbs: [ROOT, crumb("A"), crumb("B")],
      currentFolderId: "B",
    });
    await user.click(screen.getByRole("link", { name: "A" }));
    expect(vault.navigateToBreadcrumb).toHaveBeenCalledWith(1);

    await user.click(screen.getByRole("link", { name: "Vault" }));
    expect(vault.navigateToBreadcrumb).toHaveBeenCalledWith(0);
  });

  it("leaves a modified click to the browser and its real href", async () => {
    const user = userEvent.setup();
    const vault = renderToolbar({
      breadcrumbs: [ROOT, crumb("A"), crumb("B")],
      currentFolderId: "B",
    });
    const link = screen.getByRole("link", { name: "A" });
    // jsdom cannot follow the link; stop it trying, after the component has
    // had its chance to (and declined to) claim the click.
    link.addEventListener("click", (e) => e.preventDefault());
    await user.keyboard("{Control>}");
    await user.click(link);
    await user.keyboard("{/Control}");
    expect(vault.navigateToBreadcrumb).not.toHaveBeenCalled();
  });

  it("starts the folder's listing while the pointer rests on its crumb", async () => {
    const user = userEvent.setup();
    const vault = renderToolbar({
      breadcrumbs: [ROOT, crumb("A"), crumb("B")],
      currentFolderId: "B",
    });
    await user.hover(screen.getByRole("link", { name: "A" }));
    await waitFor(() => expect(vault.prefetchFolder).toHaveBeenCalledWith("A"));
  });
});
