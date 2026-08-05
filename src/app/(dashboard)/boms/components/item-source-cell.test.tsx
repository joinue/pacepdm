/**
 * The source cell decides where a BOM line takes you, and the decision is
 * pure precedence — which is exactly the kind of rule that regresses without
 * anyone noticing.
 *
 * The case that matters: an imported sub-assembly line carries BOTH a
 * `linkedBom` and a `part`, because the import sets `linkedBomId` for the
 * structure and `partId` so the line resolves to a real item for the ERP
 * push. Checking `part` first sent all 22 of the NANO-1000S's sub-assembly
 * lines to the parts list, with no way to open the assembly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ItemSourceCell } from "./bom-items-table";
import type { BOMItem } from "../types";

const linkedBom = {
  id: "bom-casting",
  name: "NANO-1000S Casting-Components",
  revision: "A",
  status: "DRAFT",
};

const part = {
  id: "part-casting",
  partNumber: "NANO-1000S Casting-Components",
  name: "NANO-1000S Casting-Components",
  description: null,
  category: "SUB_ASSEMBLY",
  revision: "A",
  lifecycleState: "WIP",
  material: null,
  unit: "EA",
  unitCost: null,
  thumbnailUrl: null,
};

const file = {
  id: "file-1",
  name: "bracket.sldprt",
  partNumber: "N1S-M-001",
  revision: "A",
  lifecycleState: "WIP",
};

function item(overrides: Partial<BOMItem>): BOMItem {
  return {
    id: "item-1",
    itemNumber: "1",
    partNumber: null,
    name: "line",
    description: null,
    quantity: 1,
    unit: "EA",
    level: 1,
    parentItemId: null,
    material: null,
    vendor: null,
    unitCost: null,
    sortOrder: 1,
    partId: null,
    linkedBomId: null,
    optionGroup: null,
    optionPrompt: null,
    file: null,
    part: null,
    linkedBom: null,
    ...overrides,
  } as BOMItem;
}

const nav = {
  vault: vi.fn(),
  parts: vi.fn(),
  bom: vi.fn(),
};

function renderCell(i: BOMItem) {
  render(
    <ItemSourceCell
      item={i}
      onNavigateToVault={nav.vault}
      onNavigateToParts={nav.parts}
      onNavigateToBom={nav.bom}
    />
  );
}

beforeEach(() => vi.clearAllMocks());

describe("ItemSourceCell", () => {
  it("opens the sub-assembly when a line has both a linked BOM and a part", async () => {
    renderCell(item({ linkedBom, part, linkedBomId: linkedBom.id, partId: part.id }));

    await userEvent.click(screen.getByRole("button", { name: /casting-components/i }));
    expect(nav.bom).toHaveBeenCalledWith("bom-casting");
    expect(nav.parts).not.toHaveBeenCalled();
  });

  it("shows the linked BOM's revision and status, not the part's", () => {
    renderCell(item({ linkedBom: { ...linkedBom, status: "RELEASED", revision: "C" }, part }));
    expect(screen.getByText("Rev C")).toBeInTheDocument();
  });

  it("opens the specific part when the line is an ordinary part", async () => {
    renderCell(item({ part, partId: part.id }));

    await userEvent.click(screen.getByRole("button", { name: part.partNumber }));
    // Deep-linked, not dumped on the parts list.
    expect(nav.parts).toHaveBeenCalledWith("part-casting");
    expect(nav.bom).not.toHaveBeenCalled();
  });

  it("opens the file in the vault when the line points at one", async () => {
    renderCell(item({ file }));

    await userEvent.click(screen.getByRole("button", { name: /bracket/i }));
    expect(nav.vault).toHaveBeenCalledWith("file-1");
  });

  it("prefers a part over a file, and a BOM over both", async () => {
    renderCell(item({ linkedBom, part, file }));
    await userEvent.click(screen.getByRole("button", { name: /casting-components/i }));
    expect(nav.bom).toHaveBeenCalledTimes(1);
    expect(nav.parts).not.toHaveBeenCalled();
    expect(nav.vault).not.toHaveBeenCalled();
  });

  it("renders a free-text line without any navigation affordance", () => {
    renderCell(item({ partNumber: "MISC-1", name: "Loose hardware" }));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
