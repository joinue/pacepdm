import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ApprovalTimeline, formatDuration, type ApprovalTimelineEntry } from "./approval-timeline";

/**
 * The timeline is the audit story a manager reads to answer "who approved
 * this, and how long did it sit?" — so the tests are about the two things it
 * computes rather than the markup it emits: the elapsed gap between
 * consecutive events, and the label chosen for each event type.
 *
 * `stripActorPrefix` gets its own coverage through rendering because it is
 * not exported: it exists so history rows written before the engine stopped
 * prefixing details do not render the actor's name twice.
 */

let seq = 0;
function event(overrides: Partial<ApprovalTimelineEntry> = {}): ApprovalTimelineEntry {
  return {
    id: `evt-${++seq}`,
    event: "CREATED",
    details: null,
    createdAt: "2026-02-01T10:00:00.000Z",
    user: { fullName: "Alice Chen" },
    ...overrides,
  };
}

describe("ApprovalTimeline", () => {
  it("renders a default message when there is no history", () => {
    render(<ApprovalTimeline events={[]} />);
    expect(screen.getByText(/no timeline events were recorded/i)).toBeInTheDocument();
  });

  /**
   * Requests created before the history fix have no rows at all. The caller
   * that knows why gets to say so instead of the generic line.
   */
  it("lets the caller explain why the history is missing", () => {
    render(<ApprovalTimeline events={[]} emptyMessage="This request predates the audit trail." />);
    expect(screen.getByText("This request predates the audit trail.")).toBeInTheDocument();
    expect(screen.queryByText(/no timeline events were recorded/i)).not.toBeInTheDocument();
  });

  it("renders one list item per event, in the order given", () => {
    render(
      <ApprovalTimeline
        events={[
          event({ event: "CREATED" }),
          event({ event: "STEP_ACTIVATED" }),
          event({ event: "APPROVED" }),
        ]}
      />
    );
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]).getByText("Created")).toBeInTheDocument();
    expect(within(items[1]).getByText("Step activated")).toBeInTheDocument();
    expect(within(items[2]).getByText("Approved")).toBeInTheDocument();
  });

  it.each([
    ["CREATED", "Created"],
    ["STEP_ACTIVATED", "Step activated"],
    ["APPROVED", "Approved"],
    ["REJECTED", "Rejected"],
    ["RECALLED", "Recalled"],
    ["REWORK_REQUESTED", "Rework requested"],
    ["RESUBMITTED", "Resubmitted"],
    ["COMPLETED", "Completed"],
    ["DEADLINE_WARNING", "Deadline warning"],
  ])("labels a %s event as %s", (eventType, label) => {
    render(<ApprovalTimeline events={[event({ event: eventType })]} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  /**
   * The engine can grow event types faster than this component learns to style
   * them. An unknown type must still render a row rather than crash the panel.
   */
  it("falls back to a generic label for an event type it does not know", () => {
    render(<ApprovalTimeline events={[event({ event: "DELEGATED_TO_PROXY" })]} />);
    expect(screen.getByText("Event")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("shows the actor's name, and omits it for system-generated events", () => {
    render(
      <ApprovalTimeline
        events={[
          event({ event: "APPROVED", user: { fullName: "Alice Chen" } }),
          // STEP_ACTIVATED is written by the engine with a null userId.
          event({ event: "STEP_ACTIVATED", user: null, details: "Step 2: QA Team" }),
        ]}
      />
    );
    expect(screen.getByText("Alice Chen")).toBeInTheDocument();
    const items = screen.getAllByRole("listitem");
    expect(within(items[1]).queryByText("Alice Chen")).not.toBeInTheDocument();
    expect(within(items[1]).getByText("Step 2: QA Team")).toBeInTheDocument();
  });

  // ── Elapsed-time badge ────────────────────────────────────────────────────

  it("shows how long each event waited on the one before it", () => {
    render(
      <ApprovalTimeline
        events={[
          event({ event: "CREATED", createdAt: "2026-02-01T10:00:00.000Z" }),
          event({ event: "APPROVED", createdAt: "2026-02-01T12:30:00.000Z" }),
        ]}
      />
    );
    expect(screen.getByText("+2h 30m")).toBeInTheDocument();
  });

  /** The first event has nothing to be elapsed from. */
  it("shows no elapsed badge on the first event", () => {
    render(
      <ApprovalTimeline
        events={[
          event({ event: "CREATED", createdAt: "2026-02-01T10:00:00.000Z" }),
          event({ event: "APPROVED", createdAt: "2026-02-01T12:30:00.000Z" }),
        ]}
      />
    );
    const items = screen.getAllByRole("listitem");
    expect(within(items[0]).queryByText(/^\+/)).not.toBeInTheDocument();
    expect(within(items[1]).getByText(/^\+/)).toBeInTheDocument();
  });

  it("shows no elapsed badge for events written in the same instant", () => {
    const at = "2026-02-01T10:00:00.000Z";
    render(
      <ApprovalTimeline
        events={[
          event({ event: "CREATED", createdAt: at }),
          event({ event: "STEP_ACTIVATED", createdAt: at }),
        ]}
      />
    );
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
  });

  // ── Legacy actor-prefix stripping ─────────────────────────────────────────

  /**
   * Rows written before the engine stopped prefixing details look like
   * "Alice Chen: Approved — APPROVED". The header already renders the name, so
   * the prefix has to come off or it reads twice.
   */
  it("strips a legacy actor prefix from the details line", () => {
    render(
      <ApprovalTimeline
        events={[
          event({
            event: "APPROVED",
            user: { fullName: "Alice Chen" },
            details: "Alice Chen: Engineering Approval — APPROVED",
          }),
        ]}
      />
    );
    expect(screen.getByText("Engineering Approval — APPROVED")).toBeInTheDocument();
    // The name appears exactly once, in the header.
    expect(screen.getAllByText(/Alice Chen/)).toHaveLength(1);
  });

  it("strips the prefix when it was written without a colon", () => {
    render(
      <ApprovalTimeline
        events={[
          event({
            event: "APPROVED",
            user: { fullName: "Alice Chen" },
            details: "Alice Chen approved this",
          }),
        ]}
      />
    );
    expect(screen.getByText("approved this")).toBeInTheDocument();
  });

  /**
   * Only the *actor's* name comes off. A details string that happens to open
   * with somebody else's name is content, not a prefix.
   */
  it("leaves a different name at the start of details alone", () => {
    render(
      <ApprovalTimeline
        events={[
          event({
            event: "REWORK_REQUESTED",
            user: { fullName: "Alice Chen" },
            details: "Bob Smith should review the tolerance stack",
          }),
        ]}
      />
    );
    expect(screen.getByText("Bob Smith should review the tolerance stack")).toBeInTheDocument();
  });

  it("renders details untouched when the event has no actor", () => {
    render(
      <ApprovalTimeline
        events={[event({ event: "STEP_ACTIVATED", user: null, details: "Step 1: Engineering" })]}
      />
    );
    expect(screen.getByText("Step 1: Engineering")).toBeInTheDocument();
  });

  it("renders a row with no details at all", () => {
    render(<ApprovalTimeline events={[event({ event: "CREATED", details: null })]} />);
    expect(screen.getByText("Created")).toBeInTheDocument();
  });
});

// ── formatDuration ──────────────────────────────────────────────────────────
//
// Exported so the parent surface can show an aggregate lifetime. The
// granularity is deliberate: a manager cares about "3m" and "2d 4h", never
// about milliseconds.

describe("formatDuration", () => {
  it.each([
    [0, "<1s"],
    [999, "<1s"],
    [1000, "1s"],
    [59_000, "59s"],
    [60_000, "1m"],
    [90_000, "1m"],
    [59 * 60_000, "59m"],
    [60 * 60_000, "1h"],
    [90 * 60_000, "1h 30m"],
    [23 * 3_600_000, "23h"],
    [24 * 3_600_000, "1d"],
    [(24 + 5) * 3_600_000, "1d 5h"],
    [13 * 24 * 3_600_000, "13d"],
  ])("renders %ims as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  /**
   * Past a fortnight the hours stop being informative — "18d 7h" is noise
   * where "18d" is the point.
   */
  it("drops the hours once a duration passes two weeks", () => {
    expect(formatDuration((14 * 24 + 7) * 3_600_000)).toBe("14d");
    expect(formatDuration((45 * 24 + 23) * 3_600_000)).toBe("45d");
  });

  it("truncates rather than rounds, so a badge never overstates the wait", () => {
    // 1h 59m 59s is "1h 59m", not "2h".
    expect(formatDuration(3_600_000 + 59 * 60_000 + 59_000)).toBe("1h 59m");
  });
});
