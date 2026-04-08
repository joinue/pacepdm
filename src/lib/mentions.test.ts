import { describe, it, expect } from "vitest";
import { parseMentionNames } from "./mentions";

describe("parseMentionNames", () => {
  it("extracts a single @FirstName LastName mention", () => {
    expect(parseMentionNames("Hey @John Smith please review")).toEqual([
      "John Smith",
    ]);
  });

  it("extracts multiple mentions", () => {
    expect(
      parseMentionNames("@Alice Johnson and @Bob Williams need to approve")
    ).toEqual(["Alice Johnson", "Bob Williams"]);
  });

  it("handles three-word names", () => {
    expect(parseMentionNames("CC @Mary Jane Watson on this")).toEqual([
      "Mary Jane Watson",
    ]);
  });

  it("deduplicates repeated mentions", () => {
    expect(
      parseMentionNames("@John Smith mentioned @John Smith again")
    ).toEqual(["John Smith"]);
  });

  it("returns empty array when no mentions", () => {
    expect(parseMentionNames("No mentions here")).toEqual([]);
  });

  it("ignores lowercase names after @", () => {
    expect(parseMentionNames("email me at @john smith")).toEqual([]);
  });

  it("ignores single-word @ references", () => {
    expect(parseMentionNames("@Admin please check")).toEqual([]);
  });

  it("handles mentions at start of text", () => {
    expect(parseMentionNames("@Jane Doe approved this")).toEqual(["Jane Doe"]);
  });

  it("handles mentions at end of text", () => {
    expect(parseMentionNames("Assigned to @Jane Doe")).toEqual(["Jane Doe"]);
  });

  it("handles empty string", () => {
    expect(parseMentionNames("")).toEqual([]);
  });

  it("requires capitalized first letter of each name part", () => {
    // First part capitalized, second lowercase → no match
    expect(parseMentionNames("@John smith")).toEqual([]);
    // Both capitalized → match
    expect(parseMentionNames("@John Smith")).toEqual(["John Smith"]);
  });
});
