import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ApiError } from "@/lib/api-client";
import { EcoBlockersPanel, blockersFromError } from "./eco-blockers-panel";

/**
 * A refused submit or implement names at most four problems in its message,
 * which is all a toast can show. The rest used to be unreachable.
 */

const six = [
  "a.SLDDRW is checked out by Bob.",
  "b.SLDDRW is in the trash.",
  "c.SLDDRW is In Review.",
  "d.SLDDRW is checked out by Bob.",
  "e.SLDDRW is checked out by Bob.",
  "Part PN-1042 is in the trash.",
];

describe("blockersFromError", () => {
  it("reads the full list from a refusal", () => {
    const err = new ApiError("ECO-0042 cannot be submitted yet: …", 409, { blockers: six });
    expect(blockersFromError(err)).toEqual(six);
  });

  it("ignores errors that are not a blocker refusal", () => {
    expect(blockersFromError(new ApiError("Forbidden", 403, { blockers: six }))).toBeNull();
    expect(blockersFromError(new ApiError("Conflict", 409))).toBeNull();
    expect(blockersFromError(new ApiError("Conflict", 409, { blockers: [] }))).toBeNull();
    expect(blockersFromError(new Error("network"))).toBeNull();
  });
});

describe("EcoBlockersPanel", () => {
  it("lists every blocker, not just the four the message had room for", () => {
    render(
      <EcoBlockersPanel
        ecoNumber="ECO-0042"
        action="submitted"
        blockers={six}
        retrying={false}
        onRetry={() => {}}
        onDismiss={() => {}}
      />
    );
    expect(screen.getByText("6 things stop ECO-0042 being submitted")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByText("Part PN-1042 is in the trash.")).toBeTruthy();
  });

  it("tries again, and cannot while a try is running", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <EcoBlockersPanel
        ecoNumber="ECO-0042"
        action="implemented"
        blockers={[six[0]]}
        retrying={false}
        onRetry={onRetry}
        onDismiss={() => {}}
      />
    );
    expect(screen.getByText("One thing stops ECO-0042 being implemented")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(
      <EcoBlockersPanel
        ecoNumber="ECO-0042"
        action="implemented"
        blockers={[six[0]]}
        retrying
        onRetry={onRetry}
        onDismiss={() => {}}
      />
    );
    expect((screen.getByRole("button", { name: /try again/i }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });
});
