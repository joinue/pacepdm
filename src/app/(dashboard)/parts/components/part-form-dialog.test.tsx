import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PartFormDialog } from "./part-form-dialog";
import type { Part } from "../parts-types";

/**
 * The validation this dialog owns is mostly about what a blank box means, and
 * the answer differs per field:
 *
 *   - A blank part number in AUTO mode means "let the server number it", so
 *     the key is dropped from the payload entirely. Sending `""` would make
 *     the server store an empty part number instead of generating one.
 *   - A blank cost means "not priced", which is null — not zero. A rollup that
 *     reads 0 as a real price silently understates a BOM.
 *   - Blank optional text is null rather than "", so the column stays empty
 *     rather than holding a zero-length string.
 *
 * The dialog talks to `fetch` directly rather than through `fetchJson`, so
 * `fetch` is what gets stubbed.
 */

const toastCalls = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const apiClient = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  fetchJson: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: toastCalls }));

vi.mock("@/lib/api-client", () => ({
  ...apiClient,
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

// The picker has its own suite (entity-thumbnail.test.tsx); here it is noise.
vi.mock("@/components/ui/entity-thumbnail", () => ({
  ThumbnailPicker: () => null,
}));

const onSaved = vi.fn();
const onOpenChange = vi.fn();

const existingPart = {
  id: "part-1",
  partNumber: "PN-1042",
  name: "Idler bracket",
  description: "Sheet metal",
  category: "MANUFACTURED",
  material: "AL6061",
  unitCost: 3.5,
  unit: "EA",
  notes: "Second source approved",
  thumbnailUrl: null,
} as Part;

const fetchMock = vi.fn();

function renderDialog(props: Partial<React.ComponentProps<typeof PartFormDialog>> = {}) {
  return render(
    <PartFormDialog
      open
      onOpenChange={onOpenChange}
      editingPart={null}
      partNumberMode="AUTO"
      onSaved={onSaved}
      {...props}
    />
  );
}

/** Method, URL and parsed body of the save request. */
function savedRequest() {
  const call = fetchMock.mock.calls.find(
    ([url]) => url === "/api/parts" || String(url).startsWith("/api/parts/")
  )!;
  const init = call[1] as RequestInit;
  return {
    url: call[0] as string,
    method: init.method,
    body: JSON.parse(init.body as string) as Record<string, unknown>,
  };
}

const field = (label: string) => screen.getByLabelText(label, { exact: true });
/** Its label gains an "(optional)" suffix in auto-numbering create mode. */
const partNumberField = () => screen.getByLabelText(/^Part Number/);
const saveButton = () => screen.getByRole("button", { name: /^(create|save)/i });

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ id: "part-new", partNumber: "PN-AUTO-1" }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

// ── Part-number validation ──────────────────────────────────────────────────

describe("PartFormDialog — part number", () => {
  it("marks the part number optional when the tenant auto-numbers", () => {
    renderDialog({ partNumberMode: "AUTO" });
    expect(partNumberField()).not.toBeRequired();
    expect(partNumberField()).toHaveAttribute("placeholder", "Auto-generated");
  });

  it("requires the part number when the tenant numbers by hand", () => {
    renderDialog({ partNumberMode: "MANUAL" });
    expect(partNumberField()).toBeRequired();
    expect(partNumberField()).toHaveAttribute("placeholder", "PACE-1001");
  });

  /** An existing part already has a number; blanking it is not an edit. */
  it("requires the part number when editing, even under auto-numbering", async () => {
    renderDialog({ editingPart: existingPart, partNumberMode: "AUTO" });
    await waitFor(() => expect(partNumberField()).toHaveValue("PN-1042"));
    expect(partNumberField()).toBeRequired();
  });

  /**
   * The key is deleted, not set to "". A server that receives `partNumber: ""`
   * stores an empty number instead of generating one.
   */
  it("omits the part number entirely when auto-numbering and the box is blank", async () => {
    const user = userEvent.setup();
    renderDialog({ partNumberMode: "AUTO" });
    await user.type(field("Name"), "Motor Housing");
    await user.click(saveButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedRequest().body).not.toHaveProperty("partNumber");
  });

  it("sends a part number the user typed, even under auto-numbering", async () => {
    const user = userEvent.setup();
    renderDialog({ partNumberMode: "AUTO" });
    await user.type(partNumberField(), "PN-9001");
    await user.type(field("Name"), "Motor Housing");
    await user.click(saveButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedRequest().body.partNumber).toBe("PN-9001");
  });

  it("treats a whitespace-only part number as blank", async () => {
    const user = userEvent.setup();
    renderDialog({ partNumberMode: "AUTO" });
    await user.type(partNumberField(), "   ");
    await user.type(field("Name"), "Motor Housing");
    await user.click(saveButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedRequest().body).not.toHaveProperty("partNumber");
  });
});

// ── Required fields ─────────────────────────────────────────────────────────

describe("PartFormDialog — required fields", () => {
  it("requires a name", () => {
    renderDialog();
    expect(field("Name")).toBeRequired();
  });

  it("leaves the descriptive fields optional", () => {
    renderDialog();
    expect(field("Description")).not.toBeRequired();
    expect(field("Material")).not.toBeRequired();
    expect(field("Notes")).not.toBeRequired();
    expect(field("Unit Cost ($)")).not.toBeRequired();
  });
});

// ── Payload shaping ─────────────────────────────────────────────────────────

describe("PartFormDialog — what gets sent", () => {
  async function saveWith(
    user: ReturnType<typeof userEvent.setup>,
    edits: () => Promise<void> = async () => {}
  ) {
    await user.type(field("Name"), "Motor Housing");
    await edits();
    await user.click(saveButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  }

  it("posts to the collection when creating", async () => {
    const user = userEvent.setup();
    renderDialog();
    await saveWith(user);
    expect(savedRequest()).toMatchObject({ url: "/api/parts", method: "POST" });
  });

  it("puts to the record when editing", async () => {
    const user = userEvent.setup();
    renderDialog({ editingPart: existingPart });
    await waitFor(() => expect(field("Name")).toHaveValue("Idler bracket"));
    await user.click(saveButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedRequest()).toMatchObject({ url: "/api/parts/part-1", method: "PUT" });
  });

  /**
   * Null, not zero. A BOM rollup has to be able to tell "nobody has priced
   * this yet" from "this part is free".
   */
  it("sends a null unit cost when the box is empty", async () => {
    const user = userEvent.setup();
    renderDialog();
    await saveWith(user);
    expect(savedRequest().body.unitCost).toBeNull();
  });

  it("sends an entered cost as a number", async () => {
    const user = userEvent.setup();
    renderDialog();
    await saveWith(user, async () => {
      await user.type(field("Unit Cost ($)"), "12.75");
    });
    expect(savedRequest().body.unitCost).toBe(12.75);
  });

  /** Zero is a real price and has to survive as 0. */
  it("keeps an explicit zero cost", async () => {
    const user = userEvent.setup();
    renderDialog();
    await saveWith(user, async () => {
      await user.type(field("Unit Cost ($)"), "0");
    });
    expect(savedRequest().body.unitCost).toBe(0);
  });

  it("sends blank optional text as null, not an empty string", async () => {
    const user = userEvent.setup();
    renderDialog();
    await saveWith(user);
    const body = savedRequest().body;
    expect(body.description).toBeNull();
    expect(body.material).toBeNull();
    expect(body.notes).toBeNull();
  });

  it("sends the values that were typed", async () => {
    const user = userEvent.setup();
    renderDialog();
    await saveWith(user, async () => {
      await user.type(field("Description"), "Laser cut, formed");
      await user.type(field("Material"), "AL6061");
      await user.type(field("Notes"), "Second source approved");
    });
    expect(savedRequest().body).toMatchObject({
      name: "Motor Housing",
      description: "Laser cut, formed",
      material: "AL6061",
      notes: "Second source approved",
    });
  });

  it("defaults the unit to EA", async () => {
    const user = userEvent.setup();
    renderDialog();
    await saveWith(user);
    expect(savedRequest().body.unit).toBe("EA");
  });

  it("defaults the category to MANUFACTURED", async () => {
    const user = userEvent.setup();
    renderDialog();
    await saveWith(user);
    expect(savedRequest().body.category).toBe("MANUFACTURED");
  });
});

// ── Populating from an existing part ───────────────────────────────────────

describe("PartFormDialog — editing", () => {
  it("fills every field from the part being edited", async () => {
    renderDialog({ editingPart: existingPart });
    await waitFor(() => expect(partNumberField()).toHaveValue("PN-1042"));
    expect(field("Name")).toHaveValue("Idler bracket");
    expect(field("Description")).toHaveValue("Sheet metal");
    expect(field("Material")).toHaveValue("AL6061");
    expect(field("Unit Cost ($)")).toHaveValue(3.5);
    expect(field("Unit")).toHaveValue("EA");
    expect(field("Notes")).toHaveValue("Second source approved");
  });

  it("renders nulls as empty boxes rather than the string 'null'", async () => {
    renderDialog({
      editingPart: {
        ...existingPart,
        description: null,
        material: null,
        notes: null,
        unitCost: null,
      } as Part,
    });
    await waitFor(() => expect(partNumberField()).toHaveValue("PN-1042"));
    expect(field("Description")).toHaveValue("");
    expect(field("Material")).toHaveValue("");
    expect(field("Notes")).toHaveValue("");
    expect(field("Unit Cost ($)")).toHaveValue(null);
  });

  it("titles itself for the mode it is in", async () => {
    const { unmount } = renderDialog();
    expect(screen.getByText("New Part")).toBeInTheDocument();
    unmount();

    renderDialog({ editingPart: existingPart });
    expect(screen.getByText("Edit Part")).toBeInTheDocument();
  });
});

// ── Outcome handling ────────────────────────────────────────────────────────

describe("PartFormDialog — after saving", () => {
  async function save(user: ReturnType<typeof userEvent.setup>) {
    await user.type(field("Name"), "Motor Housing");
    await user.click(saveButton());
  }

  it("closes and reloads on success", async () => {
    const user = userEvent.setup();
    renderDialog();
    await save(user);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toastCalls.success).toHaveBeenCalledWith("Part created");
  });

  it("says 'updated' rather than 'created' when editing", async () => {
    const user = userEvent.setup();
    renderDialog({ editingPart: existingPart });
    await waitFor(() => expect(field("Name")).toHaveValue("Idler bracket"));
    await user.click(saveButton());
    await waitFor(() => expect(toastCalls.success).toHaveBeenCalledWith("Part updated"));
  });

  /**
   * On failure the dialog stays open with the user's input intact, and the
   * server's own message is what reaches them — a generic "Failed to save"
   * hides the duplicate-part-number case that actually caused it.
   */
  it("surfaces the server's message and stays open on failure", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Part number PN-9001 already exists" }),
    });
    renderDialog();
    await save(user);

    await waitFor(() =>
      expect(toastCalls.error).toHaveBeenCalledWith("Part number PN-9001 already exists")
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(field("Name")).toHaveValue("Motor Housing");
  });

  it("re-enables the save button after a failure so the user can retry", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "nope" }) });
    renderDialog();
    await save(user);
    await waitFor(() => expect(toastCalls.error).toHaveBeenCalled());
    expect(saveButton()).toBeEnabled();
  });
});

/**
 * Two cost fields, and the difference is authority rather than precision.
 * `estimatedCost` is an engineer's figure and is always writable;
 * `unitCost` is the real number and goes read-only once the tenant has a
 * connected cost system. See docs/decisions/erp-ownership.md.
 */
describe("PartFormDialog — cost fields", () => {
  it("offers both cost fields", () => {
    renderDialog();
    expect(field("Est. Cost ($)")).toBeInTheDocument();
    expect(field("Unit Cost ($)")).toBeInTheDocument();
  });

  it("leaves both editable when cost is owned here", () => {
    renderDialog({ costSource: "OPEN" });
    expect(field("Unit Cost ($)")).toBeEnabled();
    expect(field("Est. Cost ($)")).toBeEnabled();
  });

  /**
   * The estimate stays open in both modes. Locking it too would leave an
   * engineer with nowhere to record a figure, which is the failure that made
   * a single relabelled field the wrong answer.
   */
  it("locks only the authoritative field when an external system owns cost", () => {
    renderDialog({ costSource: "LOCKED" });
    expect(field("Unit Cost ($)")).toBeDisabled();
    expect(field("Est. Cost ($)")).toBeEnabled();
  });

  it("says where to put a figure instead when unit cost is locked", () => {
    renderDialog({ costSource: "LOCKED" });
    expect(screen.getByText(/put your own figure in est\. cost/i)).toBeInTheDocument();
  });

  it("sends both costs as numbers", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(field("Name"), "Bracket");
    await user.type(field("Est. Cost ($)"), "3.50");
    await user.type(field("Unit Cost ($)"), "4.25");
    await user.click(saveButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedRequest().body).toMatchObject({ estimatedCost: 3.5, unitCost: 4.25 });
  });

  it("sends null for a cost left blank, not zero", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(field("Name"), "Bracket");
    await user.click(saveButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedRequest().body.estimatedCost).toBeNull();
    expect(savedRequest().body.unitCost).toBeNull();
  });

  it("fills both from the part being edited", async () => {
    renderDialog({
      editingPart: { ...existingPart, unitCost: 4.25, estimatedCost: 3.5 } as Part,
    });
    await waitFor(() => expect(field("Unit Cost ($)")).toHaveValue(4.25));
    expect(field("Est. Cost ($)")).toHaveValue(3.5);
  });

  it("shows an empty box rather than 'null' for a part with no estimate", async () => {
    renderDialog({ editingPart: { ...existingPart, estimatedCost: null } as Part });
    await waitFor(() => expect(partNumberField()).toHaveValue("PN-1042"));
    expect(field("Est. Cost ($)")).toHaveValue(null);
  });
});
