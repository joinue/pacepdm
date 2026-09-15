import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { EcoApprovalTab } from "./eco-approval-tab";
import type { ApprovalData, ApprovalDecision } from "../types";

/**
 * A resolved step now closes the seats it no longer needs as `NOT_NEEDED`
 * (see closeOpenSeats in lib/approval-engine.ts). The row renderer falls back
 * to the PENDING config for a status it does not know, so without a label for
 * it a closed seat read as "Pending" — the one thing it is not.
 */

function seat(id: string, status: string, decider: string | null): ApprovalDecision {
  return {
    id,
    status,
    signatureLabel: "Engineering sign-off",
    approvalMode: "MAJORITY",
    comment: null,
    decidedAt: decider ? "2026-09-10T12:00:00.000Z" : null,
    deadlineAt: null,
    group: { name: `Engineering ${id}` },
    decider: decider ? { fullName: decider } : null,
    step: { stepOrder: 1, signatureLabel: "Engineering sign-off" },
  };
}

const approval: ApprovalData = {
  id: "req-1",
  title: "ECO-0042: Bracket change",
  status: "APPROVED",
  currentStepOrder: 1,
  createdAt: "2026-09-09T12:00:00.000Z",
  completedAt: "2026-09-10T12:00:00.000Z",
  requestedBy: { fullName: "Alice", email: "alice@example.com" },
  workflow: { name: "ECO review" },
  decisions: [
    seat("a", "APPROVED", "Alice"),
    seat("b", "APPROVED", "Bob"),
    seat("c", "NOT_NEEDED", null),
  ],
  timeline: [],
};

describe("EcoApprovalTab", () => {
  it("labels a seat its step resolved without as not needed, not pending", () => {
    render(<EcoApprovalTab approval={approval} loading={false} />);

    const closedRow = screen.getByText("Engineering c").parentElement!;
    expect(within(closedRow).getByText("Not needed")).toBeInTheDocument();
    expect(screen.queryByText("Pending")).not.toBeInTheDocument();
  });
});
