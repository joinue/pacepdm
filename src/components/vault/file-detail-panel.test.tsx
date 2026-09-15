import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The detail panel re-reads the file whenever the row or its versions change
 * — a teammate's check-out, a transition, the CAD viewer saving a thumbnail it
 * just captured. Each re-read used to reset Part Number, Description, Category
 * and every custom property to the server's values, so whatever the user was
 * typing disappeared.
 *
 * Realtime is mocked at the hook: each test holds the subscription's callback
 * and fires it the way a Postgres change would.
 */

const realtime = vi.hoisted(() => ({ handlers: {} as Record<string, () => void> }));
vi.mock("@/hooks/use-realtime-table", () => ({
  useRealtimeTable: ({ table, onChange }: { table: string; onChange: () => void }) => {
    realtime.handlers[table] = onChange;
  },
}));

const server = vi.hoisted(() => ({
  file: null as Record<string, unknown> | null,
  saves: [] as Array<Record<string, unknown>>,
  failSave: null as string | null,
  revisions: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/api-client", () => ({
  fetchJson: vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    if (init?.method === "PUT" && url.endsWith("/metadata")) {
      if (server.failSave) {
        throw new Error(server.failSave);
      }
      server.saves.push(init.body as Record<string, unknown>);
      return { ok: true };
    }
    if (url.endsWith("/where-used")) return { boms: [], representsBoms: [], ecos: [] };
    if (url.endsWith("/revisions")) return structuredClone(server.revisions);
    if (url.endsWith("/parts")) return [];
    return structuredClone(server.file);
  }),
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  isAbortError: () => false,
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/vault/cad-viewer-lazy", () => ({ CadViewer: () => null }));
vi.mock("@/components/share/share-dialog", () => ({ ShareDialog: () => null }));
vi.mock("@/lib/file-download", () => ({ downloadVaultFile: vi.fn() }));

import { FileDetailPanel } from "./file-detail-panel";

const metadataFields = [
  { id: "material", name: "Material", fieldType: "TEXT", options: null, isRequired: false },
];

function fileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "f1",
    name: "bracket.sldprt",
    partNumber: "PN-1",
    description: "Bracket",
    fileType: "sldprt",
    category: "PART",
    currentVersion: 1,
    revision: "A",
    isFrozen: false,
    lifecycleState: "WIP",
    isCheckedOut: false,
    checkedOutById: null,
    checkedOutBy: null,
    checkedOutAt: null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    thumbnailKey: "has-one",
    folder: { name: "Parts", path: "/Parts" },
    versions: [],
    metadata: [
      {
        id: "mv1",
        fieldId: "material",
        value: "AL6061",
        field: { name: "Material", fieldType: "TEXT" },
      },
    ],
    ...overrides,
  };
}

const onDirtyChange = vi.fn();
const onRefresh = vi.fn();

async function renderPanel() {
  render(
    <FileDetailPanel
      fileId="f1"
      metadataFields={metadataFields}
      onClose={vi.fn()}
      onRefresh={onRefresh}
      userId="u1"
      onDirtyChange={onDirtyChange}
    />
  );
  await waitFor(() => expect(screen.getByLabelText("Part Number")).toHaveValue("PN-1"));
}

/** The server row changes and Postgres tells the subscription. */
async function remoteChange(overrides: Record<string, unknown>) {
  server.file = fileRow(overrides);
  await act(async () => {
    realtime.handlers.files();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  server.file = fileRow();
  server.saves.length = 0;
  server.failSave = null;
  server.revisions = [];
  realtime.handlers = {};
  // FilePreview asks for a preview with plain fetch.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ canPreview: false, fileType: "sldprt" }) }))
  );
});

describe("FileDetailPanel — a refresh does not wipe unsaved property edits", () => {
  it("keeps a half-typed description when the file changes elsewhere — the reported bug", async () => {
    const user = userEvent.setup();
    await renderPanel();
    await user.clear(screen.getByLabelText("Description"));
    await user.type(screen.getByLabelText("Description"), "Bracket, half-typ");

    await remoteChange({ partNumber: "PN-2", lifecycleState: "In Review" });

    // The refresh landed: the untouched field shows the server's new value…
    await waitFor(() => expect(screen.getByLabelText("Part Number")).toHaveValue("PN-2"));
    // …and the field being edited still shows what the user typed.
    expect(screen.getByLabelText("Description")).toHaveValue("Bracket, half-typ");
  });

  it("keeps an in-progress custom property the same way", async () => {
    const user = userEvent.setup();
    await renderPanel();
    await user.clear(screen.getByLabelText("Material"));
    await user.type(screen.getByLabelText("Material"), "SS304");

    await remoteChange({ description: "Renamed elsewhere" });

    await waitFor(() =>
      expect(screen.getByLabelText("Description")).toHaveValue("Renamed elsewhere")
    );
    expect(screen.getByLabelText("Material")).toHaveValue("SS304");
  });

  it("keeps the edit through a version change as well", async () => {
    const user = userEvent.setup();
    await renderPanel();
    await user.type(screen.getByLabelText("Part Number"), "-B");
    server.file = fileRow({ currentVersion: 2, description: "New version" });
    await act(async () => {
      realtime.handlers.file_versions();
    });
    await waitFor(() => expect(screen.getByLabelText("Description")).toHaveValue("New version"));
    expect(screen.getByLabelText("Part Number")).toHaveValue("PN-1-B");
  });

  it("says so when someone else changed the field being edited, and can take their value", async () => {
    const user = userEvent.setup();
    await renderPanel();
    await user.clear(screen.getByLabelText("Description"));
    await user.type(screen.getByLabelText("Description"), "Mine");

    await remoteChange({ description: "Theirs" });

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(/changed this file/i);
    expect(screen.getByLabelText("Description")).toHaveValue("Mine");

    await user.click(within(notice).getByRole("button", { name: /discard mine/i }));
    expect(screen.getByLabelText("Description")).toHaveValue("Theirs");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("FileDetailPanel — unsaved state", () => {
  it("reports unsaved edits to the page, and clears them on save", async () => {
    const user = userEvent.setup();
    await renderPanel();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    await user.type(screen.getByLabelText("Description"), " v2");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    server.file = fileRow({ description: "Bracket v2" });
    await user.click(screen.getByRole("button", { name: /save properties/i }));

    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    expect(server.saves).toEqual([
      {
        partNumber: "PN-1",
        description: "Bracket v2",
        category: "PART",
        metadata: [{ fieldId: "material", value: "AL6061" }],
      },
    ]);
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalled();
  });

  it("stays unsaved when the save fails, and shows the server's reason", async () => {
    const user = userEvent.setup();
    server.failSave = "File is checked out by Dana";
    await renderPanel();
    await user.type(screen.getByLabelText("Description"), " v2");
    await user.click(screen.getByRole("button", { name: /save properties/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("checked out by Dana"))
    );
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByLabelText("Description")).toHaveValue("Bracket v2");
  });

  it("asks before the tab is closed with unsaved edits, and not otherwise", async () => {
    const user = userEvent.setup();
    await renderPanel();

    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    await user.type(screen.getByLabelText("Description"), "!");
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });
});

describe("FileDetailPanel — record links", () => {
  /** It linked to `/ecos?ecoId=`, which the ECO list page ignored. */
  it("links a version's releasing ECO to the ECO itself", async () => {
    const user = userEvent.setup();
    server.revisions = [
      {
        id: "v1",
        version: 1,
        revision: "A",
        fileSize: 10,
        comment: null,
        createdAt: "2026-09-01T00:00:00Z",
        ecoId: "eco-7",
        uploadedBy: { fullName: "Dana" },
        eco: { id: "eco-7", ecoNumber: "ECO-0007", title: "Thicker wall", status: "IMPLEMENTED" },
      },
    ];
    await renderPanel();
    await user.click(screen.getByRole("tab", { name: "Versions" }));
    const link = await screen.findByRole("link", { name: /released by ECO-0007/i });
    expect(link).toHaveAttribute("href", "/ecos/eco-7");
  });
});
