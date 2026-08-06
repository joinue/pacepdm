import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VaultFileList } from "./vault-file-list";
import type { FileItem } from "./vault-types";
import type { VaultBrowserState } from "@/hooks/use-vault-browser";

/**
 * The list itself owns no selection state — `useVaultBrowser` does. What this
 * component owns is the wiring, and the wiring is where the bugs live:
 *
 *   - A row click opens the detail panel; a checkbox click must select without
 *     also opening it. Same element tree, two different intents.
 *   - The header checkbox is "all of them", which is only meaningful against
 *     the *filtered* list, not the full one.
 *   - The context menu offers Check In only to the person holding the lock.
 *     Offering it to anyone else produces a 403 the user cannot act on.
 *
 * jsdom applies no CSS, so the `md:hidden` card view and the `hidden md:block`
 * table both render. Queries are scoped to the table where the distinction
 * matters, which is also where the checkboxes live.
 */

vi.mock("./folder-access-dialog", () => ({
  FolderAccessDialog: () => null,
}));

const ME = "user-me";

function makeFile(overrides: Partial<FileItem> = {}): FileItem {
  return {
    id: "file-1",
    name: "bracket.sldprt",
    partNumber: "PN-1042",
    description: null,
    fileType: "sldprt",
    category: "PART",
    currentVersion: 3,
    lifecycleState: "WIP",
    lifecycleId: "lc-1",
    revision: "A",
    isFrozen: false,
    isCheckedOut: false,
    checkedOutById: null,
    approvalStatus: null,
    checkedOutBy: null,
    updatedAt: "2026-02-01T10:00:00.000Z",
    thumbnailUrl: null,
    versions: [
      {
        version: 3,
        fileSize: 2048,
        createdAt: "2026-02-01T10:00:00.000Z",
        uploadedBy: { fullName: "Alice" },
      },
    ],
    ...overrides,
  };
}

type VaultOverrides = Partial<Record<keyof VaultBrowserState, unknown>>;

function makeVault(overrides: VaultOverrides = {}) {
  const vault = {
    viewMode: "folder",
    breadcrumbs: [{ id: null, name: "Vault" }],
    folders: [],
    files: [],
    filteredFiles: [],
    loading: false,
    selectedFile: null,
    selectedFiles: new Set<string>(),
    searchQuery: "",
    filterState: "all",
    dragFileId: null,
    dropTargetId: null,

    selectFile: vi.fn(),
    toggleFileSelect: vi.fn(),
    toggleSelectAll: vi.fn(),
    navigateToFolder: vi.fn(),
    navigateToBreadcrumb: vi.fn(),
    refresh: vi.fn(),
    handleDownload: vi.fn(),
    handleCheckout: vi.fn(),
    setCheckInFileId: vi.fn(),
    openTransitionDialog: vi.fn(),
    setRenameTarget: vi.fn(),
    setNewName: vi.fn(),
    openMoveDialog: vi.fn(),
    setDeleteTarget: vi.fn(),
    handleDragStart: vi.fn(),
    handleDragEnd: vi.fn(),
    handleDragOver: vi.fn(),
    handleDragLeave: vi.fn(),
    handleDrop: vi.fn(),
    ...overrides,
  };
  return vault as unknown as VaultBrowserState;
}

function renderList(overrides: VaultOverrides = {}) {
  const vault = makeVault(overrides);
  render(<VaultFileList vault={vault} userId={ME} />);
  return vault;
}

/** The desktop table — the card view duplicates its content in jsdom. */
const table = () => within(screen.getByRole("table"));

/** Data rows only, skipping the header row. */
function dataRows() {
  return table().getAllByRole("row").slice(1);
}

/**
 * Open the row's overflow menu and return its item labels. The menu content
 * lands in a portal a tick after the click, so the query has to be async.
 */
async function openMenu(user: ReturnType<typeof userEvent.setup>, row: HTMLElement) {
  const triggers = within(row).getAllByRole("button");
  await user.click(triggers[triggers.length - 1]);
  const items = await screen.findAllByRole("menuitem");
  return items.map((el) => el.textContent?.trim());
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Selection ───────────────────────────────────────────────────────────────

describe("VaultFileList — selection", () => {
  const files = [
    makeFile({ id: "f1", name: "a.sldprt" }),
    makeFile({ id: "f2", name: "b.sldprt" }),
  ];

  it("reflects which rows are selected", () => {
    renderList({ filteredFiles: files, selectedFiles: new Set(["f2"]) });
    const boxes = table().getAllByRole("checkbox");
    // [0] is the header select-all, then one per row.
    expect(boxes[1]).not.toBeChecked();
    expect(boxes[2]).toBeChecked();
  });

  it("toggles a single row without opening the detail panel", async () => {
    const user = userEvent.setup();
    const vault = renderList({ filteredFiles: files });
    await user.click(table().getAllByRole("checkbox")[1]);

    expect(vault.toggleFileSelect).toHaveBeenCalledWith("f1");
    // The row's own click handler must not also fire — checking a box to
    // queue a bulk action should not swap out the detail panel underneath.
    expect(vault.selectFile).not.toHaveBeenCalled();
  });

  it("opens the detail panel when the row itself is clicked", async () => {
    const user = userEvent.setup();
    const vault = renderList({ filteredFiles: files });
    await user.click(within(dataRows()[0]).getByText("a.sldprt"));
    expect(vault.selectFile).toHaveBeenCalledWith("f1");
  });

  it("checks the header box only when every visible row is selected", () => {
    const { rerender } = render(
      <VaultFileList
        vault={makeVault({ filteredFiles: files, selectedFiles: new Set(["f1"]) })}
        userId={ME}
      />
    );
    expect(table().getAllByRole("checkbox")[0]).not.toBeChecked();

    rerender(
      <VaultFileList
        vault={makeVault({ filteredFiles: files, selectedFiles: new Set(["f1", "f2"]) })}
        userId={ME}
      />
    );
    expect(table().getAllByRole("checkbox")[0]).toBeChecked();
  });

  /**
   * "All" means all of what is on screen. With a filter applied, a selection
   * covering the filtered rows is complete even though other files exist.
   */
  it("treats the filtered list, not the whole vault, as 'all'", () => {
    renderList({
      files: [...files, makeFile({ id: "f3" })],
      filteredFiles: files,
      selectedFiles: new Set(["f1", "f2"]),
      searchQuery: "sldprt",
    });
    expect(table().getAllByRole("checkbox")[0]).toBeChecked();
  });

  it("calls toggleSelectAll from the header box", async () => {
    const user = userEvent.setup();
    const vault = renderList({ filteredFiles: files });
    await user.click(table().getAllByRole("checkbox")[0]);
    expect(vault.toggleSelectAll).toHaveBeenCalled();
  });

  /** Nothing to select — the header box would be a no-op control. */
  it("hides the header box when there are no files", () => {
    renderList({
      filteredFiles: [],
      folders: [{ id: "d1", name: "Drawings", _count: { files: 0, children: 0 } }],
    });
    expect(table().queryAllByRole("checkbox")).toHaveLength(0);
  });
});

// ── Context menu gating ─────────────────────────────────────────────────────

describe("VaultFileList — per-file actions", () => {
  it("offers Check Out for a file nobody holds", async () => {
    const user = userEvent.setup();
    renderList({ filteredFiles: [makeFile({ isCheckedOut: false })] });
    const items = await openMenu(user, dataRows()[0]);
    expect(items).toContain("Check Out");
    expect(items).not.toContain("Check In");
  });

  it("offers Check In to the person holding the lock", async () => {
    const user = userEvent.setup();
    renderList({
      filteredFiles: [
        makeFile({ isCheckedOut: true, checkedOutById: ME, checkedOutBy: { fullName: "Me" } }),
      ],
    });
    const items = await openMenu(user, dataRows()[0]);
    expect(items).toContain("Check In");
    expect(items).not.toContain("Check Out");
  });

  /**
   * Someone else's lock: neither action applies. Offering Check In here would
   * produce a 403 the user has no way to resolve from this menu.
   */
  it("offers neither when someone else holds the lock", async () => {
    const user = userEvent.setup();
    renderList({
      filteredFiles: [
        makeFile({
          isCheckedOut: true,
          checkedOutById: "user-other",
          checkedOutBy: { fullName: "Bob Smith" },
        }),
      ],
    });
    const items = await openMenu(user, dataRows()[0]);
    expect(items).not.toContain("Check In");
    expect(items).not.toContain("Check Out");
  });

  it("names who holds a checked-out file", () => {
    renderList({
      filteredFiles: [
        makeFile({
          isCheckedOut: true,
          checkedOutById: "user-other",
          checkedOutBy: { fullName: "Bob Smith" },
        }),
      ],
    });
    expect(table().getByText("(Bob Smith)")).toBeInTheDocument();
  });

  it("wires Check Out, Download and Delete to the vault", async () => {
    const user = userEvent.setup();
    const vault = renderList({ filteredFiles: [makeFile({ id: "f9", name: "gear.sldprt" })] });

    await openMenu(user, dataRows()[0]);
    await user.click(screen.getByRole("menuitem", { name: /check out/i }));
    expect(vault.handleCheckout).toHaveBeenCalledWith("f9");

    await openMenu(user, dataRows()[0]);
    await user.click(screen.getByRole("menuitem", { name: /download/i }));
    expect(vault.handleDownload).toHaveBeenCalledWith("f9");

    await openMenu(user, dataRows()[0]);
    await user.click(screen.getByRole("menuitem", { name: /delete/i }));
    expect(vault.setDeleteTarget).toHaveBeenCalledWith({
      id: "f9",
      name: "gear.sldprt",
      type: "file",
    });
  });

  it("seeds the rename box with the current name", async () => {
    const user = userEvent.setup();
    const vault = renderList({ filteredFiles: [makeFile({ id: "f9", name: "gear.sldprt" })] });
    await openMenu(user, dataRows()[0]);
    await user.click(screen.getByRole("menuitem", { name: /rename/i }));
    expect(vault.setRenameTarget).toHaveBeenCalledWith({
      id: "f9",
      name: "gear.sldprt",
      type: "file",
    });
    expect(vault.setNewName).toHaveBeenCalledWith("gear.sldprt");
  });

  it("passes the file's lifecycle to the state-change dialog", async () => {
    const user = userEvent.setup();
    const vault = renderList({
      filteredFiles: [makeFile({ id: "f9", name: "gear.sldprt", lifecycleId: "lc-7" })],
    });
    await openMenu(user, dataRows()[0]);
    await user.click(screen.getByRole("menuitem", { name: /change state/i }));
    expect(vault.openTransitionDialog).toHaveBeenCalledWith("f9", "gear.sldprt", "lc-7");
  });

  it("passes null when the file has no lifecycle attached", async () => {
    const user = userEvent.setup();
    const vault = renderList({
      filteredFiles: [makeFile({ id: "f9", name: "gear.sldprt", lifecycleId: null })],
    });
    await openMenu(user, dataRows()[0]);
    await user.click(screen.getByRole("menuitem", { name: /change state/i }));
    expect(vault.openTransitionDialog).toHaveBeenCalledWith("f9", "gear.sldprt", null);
  });
});

// ── Thumbnail affordance ────────────────────────────────────────────────────

describe("VaultFileList — thumbnails", () => {
  /**
   * A frozen file's thumbnail cannot be replaced (the server refuses), so the
   * affordance is hidden rather than offered and then rejected.
   */
  it("offers a thumbnail upload on an editable file and hides it on a frozen one", () => {
    renderList({ filteredFiles: [makeFile({ id: "f1", isFrozen: false })] });
    expect(table().getAllByLabelText("Set thumbnail").length).toBeGreaterThan(0);

    screen.getByRole("table").remove();
    renderList({ filteredFiles: [makeFile({ id: "f2", isFrozen: true })] });
    expect(table().queryAllByLabelText("Set thumbnail")).toHaveLength(0);
  });

  it("does not offer an upload over a file that already has a thumbnail", () => {
    renderList({
      filteredFiles: [makeFile({ thumbnailUrl: "https://storage.test/thumb.png" })],
    });
    expect(table().queryAllByLabelText("Set thumbnail")).toHaveLength(0);
  });
});

// ── Empty and loading states ────────────────────────────────────────────────

describe("VaultFileList — empty and loading states", () => {
  it("shows a loading placeholder only on the very first load", () => {
    renderList({ loading: true, folders: [], filteredFiles: [] });
    expect(table().getByText("Loading...")).toBeInTheDocument();
  });

  /**
   * A refresh keeps the previous rows on screen and fades them, so navigating
   * between folders does not flash an empty table.
   */
  it("keeps the existing rows visible while refreshing", () => {
    renderList({ loading: true, filteredFiles: [makeFile({ name: "bracket.sldprt" })] });
    expect(table().queryByText("Loading...")).not.toBeInTheDocument();
    expect(table().getByText("bracket.sldprt")).toBeInTheDocument();
  });

  it("distinguishes an empty folder from an empty result set", () => {
    renderList({ filteredFiles: [], folders: [] });
    expect(table().getByText(/empty folder/i)).toBeInTheDocument();

    screen.getByRole("table").remove();
    renderList({ filteredFiles: [], folders: [], searchQuery: "widget" });
    expect(table().getByText(/no files match your filters/i)).toBeInTheDocument();
  });

  it("treats a state filter as a filter, even with no search term", () => {
    renderList({ filteredFiles: [], folders: [], filterState: "Released" });
    expect(table().getByText(/no files match your filters/i)).toBeInTheDocument();
  });

  it("explains an empty checkouts view in its own terms", () => {
    renderList({ filteredFiles: [], folders: [], viewMode: "checkouts" });
    expect(table().getByText(/no files checked out/i)).toBeInTheDocument();
  });
});

// ── Navigation ──────────────────────────────────────────────────────────────

describe("VaultFileList — navigation", () => {
  const breadcrumbs = [
    { id: null, name: "Vault" },
    { id: "d1", name: "Projects" },
    { id: "d2", name: "Gearbox" },
  ];

  it("offers a parent row inside a subfolder and navigates up from it", async () => {
    const user = userEvent.setup();
    const vault = renderList({ breadcrumbs, filteredFiles: [makeFile()] });
    const parentRow = dataRows()[0];
    expect(within(parentRow).getByText("Projects")).toBeInTheDocument();

    await user.click(within(parentRow).getByText(".."));
    // The breadcrumb one level up from the current folder.
    expect(vault.navigateToBreadcrumb).toHaveBeenCalledWith(1);
  });

  it("offers no parent row at the vault root", () => {
    renderList({ breadcrumbs: [{ id: null, name: "Vault" }], filteredFiles: [makeFile()] });
    expect(table().queryByText("..")).not.toBeInTheDocument();
  });

  /** A flat view spans folders, so there is no single parent to go up to. */
  it("offers no parent row in a flat view", () => {
    renderList({ breadcrumbs, viewMode: "checkouts", filteredFiles: [makeFile()] });
    expect(table().queryByText("..")).not.toBeInTheDocument();
  });

  it("opens a folder when its row is clicked", async () => {
    const user = userEvent.setup();
    const folder = { id: "d9", name: "Drawings", _count: { files: 4, children: 1 } };
    const vault = renderList({ folders: [folder] });
    await user.click(table().getByText("Drawings"));
    expect(vault.navigateToFolder).toHaveBeenCalledWith(folder);
  });

  it("summarises a folder's contents", () => {
    renderList({ folders: [{ id: "d9", name: "Drawings", _count: { files: 4, children: 2 } }] });
    expect(table().getByText("4 files, 2 folders")).toBeInTheDocument();
  });

  it("omits the subfolder count when there are none", () => {
    renderList({ folders: [{ id: "d9", name: "Drawings", _count: { files: 4, children: 0 } }] });
    expect(table().getByText("4 files")).toBeInTheDocument();
  });

  /**
   * A flat view row shows which folder the file actually lives in, and that
   * label navigates rather than opening the file.
   */
  it("jumps to a file's own folder from a flat view", async () => {
    const user = userEvent.setup();
    const vault = renderList({
      viewMode: "checkouts",
      filteredFiles: [
        makeFile({ folder: { id: "d5", name: "Gearbox", path: "Projects/Gearbox" } }),
      ],
    });
    await user.click(table().getByText("in Projects/Gearbox"));
    expect(vault.navigateToFolder).toHaveBeenCalledWith({ id: "d5", name: "Gearbox" });
    expect(vault.selectFile).not.toHaveBeenCalled();
  });

  it("does not show a parent-folder label in the folder view", () => {
    renderList({
      viewMode: "folder",
      filteredFiles: [
        makeFile({ folder: { id: "d5", name: "Gearbox", path: "Projects/Gearbox" } }),
      ],
    });
    expect(table().queryByText(/^in /)).not.toBeInTheDocument();
  });
});

// ── Row content ─────────────────────────────────────────────────────────────

describe("VaultFileList — row content", () => {
  it("renders revision and version together", () => {
    renderList({ filteredFiles: [makeFile({ revision: "B", currentVersion: 4 })] });
    expect(table().getByText("B.4")).toBeInTheDocument();
  });

  it("renders a dash for a file with no part number", () => {
    renderList({ filteredFiles: [makeFile({ partNumber: null })] });
    expect(table().getByText("—")).toBeInTheDocument();
  });

  it("renders a dash for a file with no versions yet", () => {
    renderList({ filteredFiles: [makeFile({ partNumber: "PN-1", versions: [] })] });
    expect(table().getByText("—")).toBeInTheDocument();
  });

  it.each([
    ["PENDING", /pending/i],
    ["REJECTED", /rejected/i],
  ])("badges a %s approval", (status, label) => {
    renderList({ filteredFiles: [makeFile({ approvalStatus: status as "PENDING" })] });
    expect(table().getAllByText(label).length).toBeGreaterThan(0);
  });

  it("shows no approval badge when there is no approval in flight", () => {
    renderList({ filteredFiles: [makeFile({ approvalStatus: null })] });
    expect(table().queryByText(/^pending$/i)).not.toBeInTheDocument();
    expect(table().queryByText(/^rejected$/i)).not.toBeInTheDocument();
  });
});
