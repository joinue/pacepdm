/**
 * StatusBadge is the single definition of what a status looks like, so these
 * tests are about the mapping, not the markup: that every status in each state
 * machine renders, that unknown statuses degrade instead of throwing, and that
 * the badge and the dot can never disagree.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge, StatusDot, toneFor, STATUS_TONES } from "./status-badge";
import { BOM_STATUS_FLOW, ECO_STATUS_FLOW } from "@/lib/status-flows";

describe("StatusBadge", () => {
  it("renders the human label rather than the enum value", () => {
    render(<StatusBadge status="IN_REVIEW" kind="bom" />);
    expect(screen.getByText("In Review")).toBeInTheDocument();
  });

  it("renders nothing when the status is absent", () => {
    const { container } = render(<StatusBadge status={null} kind="bom" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("falls back to the raw status for a tenant's custom lifecycle state", () => {
    // Lifecycle states are configurable per tenant, so an unrecognised one must
    // render as itself rather than disappearing or throwing.
    render(<StatusBadge status="Awaiting Tooling" kind="lifecycle" />);
    expect(screen.getByText("Awaiting Tooling")).toBeInTheDocument();
  });

  it("accepts an explicit label override", () => {
    render(<StatusBadge status="DRAFT" kind="bom" label="Not yet submitted" />);
    expect(screen.getByText("Not yet submitted")).toBeInTheDocument();
  });
});

describe("tone mapping", () => {
  it("covers every status in the BOM state machine", () => {
    for (const status of Object.keys(BOM_STATUS_FLOW)) {
      expect(STATUS_TONES.bom, `BOM status ${status} has no tone`).toHaveProperty(status);
    }
  });

  it("covers every status in the ECO state machine", () => {
    for (const status of Object.keys(ECO_STATUS_FLOW)) {
      expect(STATUS_TONES.eco, `ECO status ${status} has no tone`).toHaveProperty(status);
    }
  });

  it("distinguishes an in-flight ECO approval from a released BOM", () => {
    // The same word means different things per entity, which is why the map is
    // keyed by kind. If these ever collapse to one map, this fails.
    expect(toneFor("bom", "APPROVED")).toBe("info");
    expect(toneFor("eco", "APPROVED")).toBe("success");
  });

  it("keeps priority on its own axis, not folded into ECO status", () => {
    // Priority and status are different axes of the same record. Adopting
    // StatusBadge, a codemod briefly rendered `eco.priority` with kind="eco",
    // which silently greyed out HIGH and CRITICAL because those keys are absent
    // from the status map. A shared map would make that failure permanent.
    expect(toneFor("priority", "HIGH")).toBe("orange");
    expect(toneFor("priority", "CRITICAL")).toBe("error");
    expect(toneFor("eco", "HIGH")).toBe("muted"); // not a status — must not resolve
  });

  it("gives every priority level a tone and a label", () => {
    for (const p of ["LOW", "MEDIUM", "HIGH", "CRITICAL"]) {
      expect(STATUS_TONES.priority, p).toHaveProperty(p);
    }
  });

  it("degrades to muted for an unknown status or kind", () => {
    expect(toneFor("bom", "NONSENSE")).toBe("muted");
    expect(toneFor("nonexistent", "DRAFT")).toBe("muted");
    expect(toneFor("bom", null)).toBe("muted");
  });
});

describe("StatusDot", () => {
  it("is hidden from assistive technology, since the text beside it carries the meaning", () => {
    const { container } = render(<StatusDot status="RELEASED" kind="bom" />);
    expect(container.firstChild).toHaveAttribute("aria-hidden", "true");
  });

  it("uses the same tone as the badge for the same status", () => {
    // A dot and a badge showing different colours for one status is the exact
    // drift this component exists to prevent.
    const { container } = render(<StatusDot status="RELEASED" kind="bom" />);
    expect(container.firstChild).toHaveClass("bg-success");
    expect(toneFor("bom", "RELEASED")).toBe("success");
  });
});
