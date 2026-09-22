import { describe, it, expect } from "vitest";
import {
  LEAD_TIME_OPTIONS,
  LEAD_TIME_STALE_DAYS,
  daysSinceUpdate,
  describeFreshness,
  isLeadTime,
  leadTimeFreshness,
  noteLines,
  noteSummary,
} from "./lead-times";

/**
 * The sheet this replaces had no way to tell a lead time set yesterday from
 * one set in March — both are just text in a cell. Sales quoting a stale
 * number as though it were current is the failure worth catching.
 */

const now = new Date("2026-09-22T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

describe("leadTimeFreshness", () => {
  it("is unset until someone states a lead time", () => {
    expect(leadTimeFreshness({ currentLeadTime: null, updatedAt: null }, now)).toBe("unset");
    // A stamp with no value is still nobody having said.
    expect(leadTimeFreshness({ currentLeadTime: null, updatedAt: daysAgo(1) }, now)).toBe("unset");
  });

  it("is fresh inside the window", () => {
    expect(leadTimeFreshness({ currentLeadTime: "4 weeks", updatedAt: daysAgo(0) }, now)).toBe(
      "fresh"
    );
    expect(
      leadTimeFreshness(
        { currentLeadTime: "4 weeks", updatedAt: daysAgo(LEAD_TIME_STALE_DAYS - 1) },
        now
      )
    ).toBe("fresh");
  });

  it("is stale past it", () => {
    expect(
      leadTimeFreshness(
        { currentLeadTime: "6-8 weeks", updatedAt: daysAgo(LEAD_TIME_STALE_DAYS + 1) },
        now
      )
    ).toBe("stale");
  });

  it("reads an unparseable date as unset rather than as current", () => {
    expect(leadTimeFreshness({ currentLeadTime: "4 weeks", updatedAt: "whenever" }, now)).toBe(
      "unset"
    );
  });
});

describe("describeFreshness", () => {
  it("says it plainly", () => {
    expect(describeFreshness({ currentLeadTime: null, updatedAt: null }, now)).toBe("Not set yet");
    expect(describeFreshness({ currentLeadTime: "4 weeks", updatedAt: daysAgo(0) }, now)).toBe(
      "Updated today"
    );
    expect(describeFreshness({ currentLeadTime: "4 weeks", updatedAt: daysAgo(1) }, now)).toBe(
      "Updated yesterday"
    );
    expect(describeFreshness({ currentLeadTime: "4 weeks", updatedAt: daysAgo(45) }, now)).toBe(
      "Updated 45 days ago"
    );
  });
});

describe("daysSinceUpdate", () => {
  it("counts whole days, and never negative for a clock a little ahead", () => {
    expect(daysSinceUpdate({ currentLeadTime: "4 weeks", updatedAt: daysAgo(3) }, now)).toBe(3);
    expect(daysSinceUpdate({ currentLeadTime: "4 weeks", updatedAt: daysAgo(-1) }, now)).toBe(0);
    expect(daysSinceUpdate({ currentLeadTime: null, updatedAt: null }, now)).toBeNull();
  });
});

describe("isLeadTime", () => {
  it("accepts the buckets sales quotes in, and nothing else", () => {
    expect(isLeadTime("In Stock")).toBe(true);
    expect(isLeadTime("6-8 weeks")).toBe(true);
    expect(isLeadTime("Confirm")).toBe(true);
    expect(isLeadTime("about a month")).toBe(false);
    expect(isLeadTime("")).toBe(false);
  });

  it("keeps the options the spreadsheet's dropdown offered", () => {
    // Sales quotes from these words; changing one is a decision, not a tidy-up.
    expect(LEAD_TIME_OPTIONS[0]).toBe("In Stock");
    expect(LEAD_TIME_OPTIONS).toContain("12+ weeks");
    expect(LEAD_TIME_OPTIONS.at(-1)).toBe("Confirm");
  });
});

/**
 * A note began as a phrase beside a lead time and became where people explain
 * a backlog — several reasons, typed as a list.
 */
describe("noteLines", () => {
  it("reads each line as its own reason", () => {
    expect(noteLines("Casting delay\nControl boards on 12-week allocation")).toEqual([
      "Casting delay",
      "Control boards on 12-week allocation",
    ]);
  });

  it("strips the bullets people type out of habit", () => {
    expect(noteLines("- Casting delay\n* Boards allocated\n• Paint booth down")).toEqual([
      "Casting delay",
      "Boards allocated",
      "Paint booth down",
    ]);
  });

  it("drops blank lines and whitespace, and handles Windows line endings", () => {
    expect(noteLines("  Casting delay  \r\n\r\n   \r\nBoards allocated")).toEqual([
      "Casting delay",
      "Boards allocated",
    ]);
  });

  it("is empty for an empty note", () => {
    expect(noteLines(null)).toEqual([]);
    expect(noteLines("   ")).toEqual([]);
  });
});

describe("noteSummary", () => {
  it("gives the first reason and the count of the rest", () => {
    expect(noteSummary("Casting delay\nBoards allocated\nPaint booth down")).toEqual({
      first: "Casting delay",
      more: 2,
    });
    expect(noteSummary("Casting delay")).toEqual({ first: "Casting delay", more: 0 });
    expect(noteSummary(null)).toEqual({ first: null, more: 0 });
  });
});
