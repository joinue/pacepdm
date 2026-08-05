/**
 * The dialog's job is to make a large, hard-to-undo write reviewable before
 * it happens: `POST /api/boms/import` creates dozens of BOMs and hundreds of
 * parts in one call. So these tests are about the safety properties, not the
 * markup —
 *
 *   - nothing is POSTed until the user has seen a preview and confirmed;
 *   - the preview reflects the real file, because it runs the same parser the
 *     server does;
 *   - a file the parser cannot use is refused client-side, without a request;
 *   - the server's own message reaches the user on failure (the codebase-wide
 *     rule against generic "Failed to X" toasts).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { fetchJsonMock, toastMock } = vi.hoisted(() => ({
  fetchJsonMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, fetchJson: fetchJsonMock };
});

vi.mock("sonner", () => ({ toast: toastMock }));

import { ImportBomDialog } from "./import-bom-dialog";
import { ApiError } from "@/lib/api-client";

/** Two BOMs, one forward reference, one option line, one unusable row. */
const CSV = [
  "Flag,Description,Type,Part,Quantity,UOM,IsVariableQuantity,MinQuantity,MaxQuantity,OptionGroup,OptionGroupPrompt",
  "BOM,TOP-1,Top level,TRUE,1",
  "Item,Create TOP-1,Finished Good,TOP-1,1,ea",
  "Item,Add SUB-1,Raw Good,SUB-1,2,ea",
  "Item,Add OPT-A,Raw Good,OPT-A,1,ea,FALSE,0,0,Voltage,What Voltage ordered",
  "Item,Add BAD,Raw Good,BAD,many,ea",
  "BOM,SUB-1,Sub assembly,TRUE,1",
  "Item,Create SUB-1,Finished Good,SUB-1,1,ea",
  "Item,Add LEAF-1,Raw Good,LEAF-1,4,ea",
].join("\n");

const SUMMARY = {
  bomsCreated: 2,
  bomsSkipped: 0,
  partsCreated: 4,
  partsUpdated: 0,
  itemsCreated: 3,
  optionItems: 1,
  results: [
    { partNumber: "TOP-1", status: "created" as const, itemCount: 2 },
    { partNumber: "SUB-1", status: "created" as const, itemCount: 1 },
  ],
  problems: [],
  warnings: [],
};

function csvFile(contents = CSV, name = "build-list.csv") {
  return new File([contents], name, { type: "text/csv" });
}

function renderDialog(onImported = vi.fn()) {
  render(<ImportBomDialog open onOpenChange={vi.fn()} onImported={onImported} />);
  return { onImported };
}

const fileInput = () => screen.getByLabelText(/build list csv/i);
const importButton = () => screen.getByRole("button", { name: /^import/i });

beforeEach(() => {
  vi.clearAllMocks();
  fetchJsonMock.mockResolvedValue(SUMMARY);
});

describe("ImportBomDialog — before a file is chosen", () => {
  it("disables the import button", () => {
    renderDialog();
    expect(importButton()).toBeDisabled();
  });
});

describe("ImportBomDialog — preview", () => {
  it("summarises the parsed file without sending anything to the server", async () => {
    renderDialog();
    await userEvent.upload(fileInput(), csvFile());

    await screen.findByText(/nothing has been saved yet/i);
    expect(fetchJsonMock).not.toHaveBeenCalled();

    // 2 BOMs, 3 usable lines (the `Create` rows and the bad row excluded),
    // 4 distinct parts, 1 option line.
    const stat = (label: string) =>
      screen.getByText(label).parentElement?.querySelector("dd")?.textContent;
    expect(stat("BOMs")).toBe("2");
    expect(stat("Lines")).toBe("3");
    expect(stat("Parts")).toBe("4");
    expect(stat("Option lines")).toBe("1");
  });

  it("names the file so the user can confirm they picked the right one", async () => {
    renderDialog();
    await userEvent.upload(fileInput(), csvFile(CSV, "NANO-1000S.csv"));
    expect(await screen.findByText("NANO-1000S.csv")).toBeInTheDocument();
  });

  it("reports unusable rows with their line numbers, and still allows the import", async () => {
    renderDialog();
    await userEvent.upload(fileInput(), csvFile());

    expect(await screen.findByText(/1 row cannot be imported/i)).toBeInTheDocument();
    expect(screen.getByText(/line 6.*not a positive number/i)).toBeInTheDocument();
    expect(importButton()).toBeEnabled();
  });

  it("labels the button with what will actually happen", async () => {
    renderDialog();
    await userEvent.upload(fileInput(), csvFile());
    expect(await screen.findByRole("button", { name: /import 2 boms/i })).toBeInTheDocument();
  });

  it("refuses a file with no BOM rows client-side, without a request", async () => {
    renderDialog();
    await userEvent.upload(fileInput(), csvFile("name,qty\nwidget,3\n", "parts.csv"));

    expect(await screen.findByRole("alert")).toHaveTextContent(/no bom rows found/i);
    expect(fetchJsonMock).not.toHaveBeenCalled();
    expect(importButton()).toBeDisabled();
  });
});

describe("ImportBomDialog — importing", () => {
  it("posts the raw CSV as text/csv", async () => {
    renderDialog();
    await userEvent.upload(fileInput(), csvFile());
    await userEvent.click(await screen.findByRole("button", { name: /import 2 boms/i }));

    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalledTimes(1));
    expect(fetchJsonMock).toHaveBeenCalledWith("/api/boms/import", {
      method: "POST",
      body: CSV,
      headers: { "Content-Type": "text/csv" },
    });
  });

  it("shows the per-BOM result and notifies the parent", async () => {
    const { onImported } = renderDialog();
    await userEvent.upload(fileInput(), csvFile());
    await userEvent.click(await screen.findByRole("button", { name: /import 2 boms/i }));

    expect(await screen.findByText("Result")).toBeInTheDocument();
    expect(screen.getByText("TOP-1")).toBeInTheDocument();
    expect(screen.getByText("SUB-1")).toBeInTheDocument();
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(toastMock.success).toHaveBeenCalledWith("Imported 2 BOMs");
  });

  it("does not claim success when every BOM was already present", async () => {
    fetchJsonMock.mockResolvedValue({
      ...SUMMARY,
      bomsCreated: 0,
      bomsSkipped: 2,
      results: [
        { partNumber: "TOP-1", status: "skipped", reason: "A BOM with this name already exists" },
        { partNumber: "SUB-1", status: "skipped", reason: "A BOM with this name already exists" },
      ],
    });

    const { onImported } = renderDialog();
    await userEvent.upload(fileInput(), csvFile());
    await userEvent.click(await screen.findByRole("button", { name: /import 2 boms/i }));

    await waitFor(() => expect(toastMock.info).toHaveBeenCalled());
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(onImported).not.toHaveBeenCalled();
    expect(await screen.findAllByText("Skipped")).toHaveLength(2);
  });

  it("surfaces server warnings rather than dropping them", async () => {
    fetchJsonMock.mockResolvedValue({
      ...SUMMARY,
      warnings: ["3 line(s) reference a sub-assembly that was not created in this run (SUB-9)"],
    });

    renderDialog();
    await userEvent.upload(fileInput(), csvFile());
    await userEvent.click(await screen.findByRole("button", { name: /import 2 boms/i }));

    expect(await screen.findByText(/SUB-9/)).toBeInTheDocument();
  });

  it("shows the server's own error message on failure", async () => {
    fetchJsonMock.mockRejectedValue(new ApiError("CSV exceeds the 5 MB limit", 400));

    const { onImported } = renderDialog();
    await userEvent.upload(fileInput(), csvFile());
    await userEvent.click(await screen.findByRole("button", { name: /import 2 boms/i }));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("CSV exceeds the 5 MB limit"));
    expect(onImported).not.toHaveBeenCalled();
    // Still on the preview, so the user can retry without re-picking the file.
    expect(screen.getByText(/nothing has been saved yet/i)).toBeInTheDocument();
  });
});
