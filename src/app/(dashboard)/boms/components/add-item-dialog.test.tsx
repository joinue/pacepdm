import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddItemDialog } from "./add-item-dialog";
import type { BOM } from "../types";

/**
 * Three modes share one form, and the payload differs by mode: a library part
 * carries `partId`, a sub-assembly carries `linkedBomId`, a manual entry
 * carries neither. Getting that wrong links a BOM row to the wrong record, so
 * the tests assert on what actually reaches the API.
 *
 * The quantity and cost fields are text inputs parsed on submit. Those parses
 * are the arithmetic the strategy doc calls out: an empty quantity has to
 * become 1, not NaN, and an empty cost has to become null, not 0.
 */

const fetchJson = vi.hoisted(() => vi.fn());
const toastCalls = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/api-client", () => ({
  fetchJson,
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

vi.mock("sonner", () => ({ toast: toastCalls }));

const boms: BOM[] = [
  { id: "bom-1", name: "Top level", status: "DRAFT" },
  { id: "bom-2", name: "Rotor sub-assembly", status: "RELEASED" },
  { id: "bom-3", name: "Stator sub-assembly", status: "DRAFT" },
] as BOM[];

const onAdded = vi.fn();
const onOpenChange = vi.fn();

function renderDialog(props: Partial<React.ComponentProps<typeof AddItemDialog>> = {}) {
  return render(
    <AddItemDialog
      open
      onOpenChange={onOpenChange}
      selectedBomId="bom-1"
      itemCount={4}
      initialItemNumber="005"
      boms={boms}
      onAdded={onAdded}
      {...props}
    />
  );
}

/** The body of the most recent POST to the items endpoint. */
function submittedBody() {
  const call = fetchJson.mock.calls.at(-1);
  return (call?.[1] as { body: Record<string, unknown> }).body;
}

/** Exact match — "Unit" and "Unit Cost ($)" are both on the manual form. */
function field(label: string) {
  return screen.getByLabelText(label, { exact: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchJson.mockResolvedValue({ id: "item-new" });
});

// ── Mode selection and what each mode submits ───────────────────────────────

describe("AddItemDialog — submit gating", () => {
  it("opens in library mode with the add button disabled until a part is picked", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: /add item/i })).toBeDisabled();
  });

  it("stays disabled in manual mode until the item has a name", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: /new part/i }));

    const add = screen.getByRole("button", { name: /add item/i });
    expect(add).toBeDisabled();
    await user.type(field("Name"), "Motor Housing");
    expect(add).toBeEnabled();
  });

  /** Whitespace is not a name. */
  it("does not accept a name of only spaces", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: /new part/i }));
    await user.type(field("Name"), "   ");
    expect(screen.getByRole("button", { name: /add item/i })).toBeDisabled();
  });

  it("stays disabled in sub-assembly mode until a BOM is chosen", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: /sub-assembly/i }));
    await user.type(field("Name"), "Rotor");
    // A name alone is not enough — the link target is what defines the row.
    expect(screen.getByRole("button", { name: /add item/i })).toBeDisabled();
  });
});

describe("AddItemDialog — manual entry", () => {
  async function fillManual(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: /new part/i }));
    await user.type(field("Name"), "Motor Housing");
  }

  it("posts a manual item with neither a part nor a linked BOM", async () => {
    const user = userEvent.setup();
    renderDialog();
    await fillManual(user);
    await user.click(screen.getByRole("button", { name: /add item/i }));

    await waitFor(() => expect(fetchJson).toHaveBeenCalled());
    expect(fetchJson.mock.calls[0][0]).toBe("/api/boms/bom-1/items");
    expect(submittedBody()).toMatchObject({
      name: "Motor Housing",
      partId: null,
      linkedBomId: null,
      fileId: null,
    });
  });

  it("carries the item number it was opened with", async () => {
    const user = userEvent.setup();
    renderDialog({ initialItemNumber: "007" });
    await fillManual(user);
    await user.click(screen.getByRole("button", { name: /add item/i }));
    await waitFor(() => expect(submittedBody().itemNumber).toBe("007"));
  });

  /**
   * `sortOrder` comes from the current item count, which is what puts a new
   * row at the end of the list rather than colliding with an existing one.
   */
  it("appends the row using the current item count as its sort order", async () => {
    const user = userEvent.setup();
    renderDialog({ itemCount: 12 });
    await fillManual(user);
    await user.click(screen.getByRole("button", { name: /add item/i }));
    await waitFor(() => expect(submittedBody().sortOrder).toBe(12));
  });
});

// ── Quantity and cost parsing ──────────────────────────────────────────────

describe("AddItemDialog — quantity and cost", () => {
  async function submitManualWith(
    user: ReturnType<typeof userEvent.setup>,
    edits: (u: ReturnType<typeof userEvent.setup>) => Promise<void>
  ) {
    await user.click(screen.getByRole("button", { name: /new part/i }));
    await user.type(field("Name"), "Bracket");
    await edits(user);
    await user.click(screen.getByRole("button", { name: /add item/i }));
    await waitFor(() => expect(fetchJson).toHaveBeenCalled());
  }

  it("defaults the quantity to 1", async () => {
    const user = userEvent.setup();
    renderDialog();
    await submitManualWith(user, async () => {});
    expect(submittedBody().quantity).toBe(1);
  });

  it("sends a fractional quantity as a number, not a string", async () => {
    const user = userEvent.setup();
    renderDialog();
    await submitManualWith(user, async (u) => {
      await u.clear(field("Quantity"));
      await u.type(field("Quantity"), "2.5");
    });
    expect(submittedBody().quantity).toBe(2.5);
  });

  /**
   * The field is a controlled text input, so clearing it leaves an empty
   * string. `parseFloat("")` is NaN, and NaN would reach the API as `null`
   * through JSON — the `|| 1` fallback is what keeps a cleared box meaning
   * "one of these".
   */
  it("falls back to 1 when the quantity box is left empty", async () => {
    const user = userEvent.setup();
    renderDialog();
    await submitManualWith(user, async (u) => {
      await u.clear(field("Quantity"));
    });
    expect(submittedBody().quantity).toBe(1);
    expect(Number.isNaN(submittedBody().quantity)).toBe(false);
  });

  it("defaults the unit to EA when the box is cleared", async () => {
    const user = userEvent.setup();
    renderDialog();
    await submitManualWith(user, async (u) => {
      await u.clear(field("Unit"));
    });
    expect(submittedBody().unit).toBe("EA");
  });

  /**
   * An unpriced part is not a free part. Cost has to arrive as null so a
   * rollup can distinguish "no price yet" from "costs nothing".
   */
  it("sends a null unit cost when none was entered, not zero", async () => {
    const user = userEvent.setup();
    renderDialog();
    await submitManualWith(user, async () => {});
    expect(submittedBody().unitCost).toBeNull();
  });

  it("sends an entered unit cost as a number", async () => {
    const user = userEvent.setup();
    renderDialog();
    await submitManualWith(user, async (u) => {
      await u.type(field("Unit Cost ($)"), "12.75");
    });
    expect(submittedBody().unitCost).toBe(12.75);
  });

  /** Zero is a real price and must survive as 0, not become null. */
  it("keeps an explicit zero cost", async () => {
    const user = userEvent.setup();
    renderDialog();
    await submitManualWith(user, async (u) => {
      await u.type(field("Unit Cost ($)"), "0");
    });
    expect(submittedBody().unitCost).toBe(0);
  });

  it("sends empty optional text fields as null rather than empty strings", async () => {
    const user = userEvent.setup();
    renderDialog();
    await submitManualWith(user, async () => {});
    const body = submittedBody();
    expect(body.partNumber).toBeNull();
    expect(body.material).toBeNull();
    expect(body.vendor).toBeNull();
    expect(body.description).toBeNull();
  });
});

// ── Sub-assembly mode ──────────────────────────────────────────────────────

describe("AddItemDialog — sub-assembly mode", () => {
  it("offers every BOM except the one being edited", async () => {
    const user = userEvent.setup();
    renderDialog({ selectedBomId: "bom-1" });
    await user.click(screen.getByRole("button", { name: /sub-assembly/i }));

    expect(screen.getByRole("button", { name: /rotor sub-assembly/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /stator sub-assembly/i })).toBeInTheDocument();
    // A BOM cannot contain itself.
    expect(screen.queryByRole("button", { name: /^top level/i })).not.toBeInTheDocument();
  });

  it("says so when there is nothing to nest", async () => {
    const user = userEvent.setup();
    renderDialog({ boms: [boms[0]], selectedBomId: "bom-1" });
    await user.click(screen.getByRole("button", { name: /sub-assembly/i }));
    expect(screen.getByText(/no other boms available/i)).toBeInTheDocument();
  });

  it("posts the chosen BOM as linkedBomId and defaults the name to its own", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: /sub-assembly/i }));
    await user.click(screen.getByRole("button", { name: /rotor sub-assembly/i }));
    await user.click(screen.getByRole("button", { name: /add item/i }));

    await waitFor(() => expect(fetchJson).toHaveBeenCalled());
    expect(submittedBody()).toMatchObject({
      linkedBomId: "bom-2",
      name: "Rotor sub-assembly",
      partId: null,
    });
  });

  it("lets the chosen BOM be cleared again", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: /sub-assembly/i }));
    await user.click(screen.getByRole("button", { name: /rotor sub-assembly/i }));
    // Selected — the picker collapses to a chip.
    expect(screen.queryByRole("button", { name: /stator sub-assembly/i })).not.toBeInTheDocument();

    const chip = screen.getByText("Rotor sub-assembly").closest("div")!;
    await user.click(within(chip).getByRole("button"));
    expect(screen.getByRole("button", { name: /stator sub-assembly/i })).toBeInTheDocument();
  });

  /**
   * Switching modes has to drop whatever the previous mode selected, or a
   * manual entry would silently carry a `linkedBomId` from a sub-assembly the
   * user changed their mind about.
   */
  it("drops the linked BOM when the user switches back to manual entry", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: /sub-assembly/i }));
    await user.click(screen.getByRole("button", { name: /rotor sub-assembly/i }));
    await user.click(screen.getByRole("button", { name: /new part/i }));
    await user.click(screen.getByRole("button", { name: /add item/i }));

    await waitFor(() => expect(fetchJson).toHaveBeenCalled());
    expect(submittedBody().linkedBomId).toBeNull();
  });
});

// ── Parts library mode ─────────────────────────────────────────────────────

describe("AddItemDialog — parts library mode", () => {
  const part = {
    id: "part-1",
    partNumber: "PN-1042",
    name: "Idler bracket",
    unitCost: 3.5,
    thumbnailUrl: null,
  };

  async function pickPart(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByPlaceholderText(/search parts/i), "idler");
    await waitFor(() => expect(screen.getByText("Idler bracket")).toBeInTheDocument(), {
      timeout: 2000,
    });
    await user.click(screen.getByText("Idler bracket"));
  }

  it("does not search for a query shorter than two characters", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByPlaceholderText(/search parts/i), "i");
    await new Promise((r) => setTimeout(r, 400));
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("posts the selected part's id and copies its number, name and cost in", async () => {
    const user = userEvent.setup();
    fetchJson.mockResolvedValueOnce([part]);
    renderDialog();
    await pickPart(user);
    await user.click(screen.getByRole("button", { name: /add item/i }));

    await waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(2));
    expect(submittedBody()).toMatchObject({
      partId: "part-1",
      partNumber: "PN-1042",
      name: "Idler bracket",
      unitCost: 3.5,
      linkedBomId: null,
    });
  });

  it("reports when a search finds nothing", async () => {
    const user = userEvent.setup();
    fetchJson.mockResolvedValueOnce([]);
    renderDialog();
    await user.type(screen.getByPlaceholderText(/search parts/i), "zzz");
    expect(await screen.findByText(/no parts found/i, {}, { timeout: 2000 })).toBeInTheDocument();
  });

  it("survives a failed search without breaking the form", async () => {
    const user = userEvent.setup();
    fetchJson.mockRejectedValueOnce(new Error("search is down"));
    renderDialog();
    await user.type(screen.getByPlaceholderText(/search parts/i), "idler");
    expect(await screen.findByText(/no parts found/i, {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add item/i })).toBeDisabled();
  });
});

// ── Submission outcome ─────────────────────────────────────────────────────

describe("AddItemDialog — after submitting", () => {
  async function submitManual(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: /new part/i }));
    await user.type(field("Name"), "Bracket");
    await user.click(screen.getByRole("button", { name: /add item/i }));
  }

  it("closes and tells the parent to reload on success", async () => {
    const user = userEvent.setup();
    renderDialog();
    await submitManual(user);
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toastCalls.success).toHaveBeenCalledWith("Item added");
  });

  /**
   * On failure the dialog stays open with the user's input intact — the
   * alternative is retyping a form they already filled in.
   */
  it("surfaces the server's message and stays open on failure", async () => {
    const user = userEvent.setup();
    fetchJson.mockRejectedValueOnce(new Error("Item number 005 already exists"));
    renderDialog();
    await submitManual(user);

    await waitFor(() =>
      expect(toastCalls.error).toHaveBeenCalledWith("Item number 005 already exists")
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(onAdded).not.toHaveBeenCalled();
    expect(field("Name")).toHaveValue("Bracket");
  });

  it("resets the form when cancelled", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: /new part/i }));
    await user.type(field("Name"), "Bracket");
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(fetchJson).not.toHaveBeenCalled();
  });
});
