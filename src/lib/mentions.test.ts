import { describe, it, expect } from "vitest";
import { findMentionedUsers } from "./mentions";

const john = { id: "u-john", fullName: "John Smith" };
const alice = { id: "u-alice", fullName: "Alice Johnson" };
const bob = { id: "u-bob", fullName: "Bob Williams" };
const mary = { id: "u-mary", fullName: "Mary Jane Watson" };
const ann = { id: "u-ann", fullName: "Ann" };
const annLee = { id: "u-annlee", fullName: "Ann Lee" };
const jean = { id: "u-jean", fullName: "Jean-Luc O'Neill" };
const zoe = { id: "u-zoe", fullName: "Zoë Müller" };

const team = [john, alice, bob, mary, ann, annLee, jean, zoe];

const ids = (text: string, users = team) => findMentionedUsers(text, users).map((u) => u.id);

/**
 * Mentions are read against the workspace's names, not guessed from the
 * text. The old parser took "@ then two or three capitalised words", so
 * "@John Smith Please review" looked up "John Smith Please" and matched
 * nobody — silently.
 */
describe("findMentionedUsers", () => {
  it("finds a mention followed by more capitalised words", () => {
    expect(ids("Hey @John Smith Please review this")).toEqual(["u-john"]);
  });

  it("finds several mentions, in order", () => {
    expect(ids("@Alice Johnson and @Bob Williams need to approve")).toEqual(["u-alice", "u-bob"]);
  });

  it("handles three-word names", () => {
    expect(ids("CC @Mary Jane Watson on this")).toEqual(["u-mary"]);
  });

  it("reports each person once", () => {
    expect(ids("@John Smith mentioned @John Smith again")).toEqual(["u-john"]);
  });

  it("finds nothing without an @", () => {
    expect(ids("No mentions here")).toEqual([]);
    expect(ids("")).toEqual([]);
  });

  it("does not care how the name was typed", () => {
    expect(ids("email @john smith")).toEqual(["u-john"]);
    expect(ids("@JOHN SMITH")).toEqual(["u-john"]);
  });

  it("does not match a name that is only a prefix of what was typed", () => {
    // "Johnson" is not "John", and nobody is called "John Smithson".
    expect(ids("@Johnson please")).toEqual([]);
    expect(ids("@John Smithson")).toEqual([]);
  });

  it("does not match a partial name", () => {
    expect(ids("@John please")).toEqual([]);
  });

  it("prefers the longest name at the same @", () => {
    expect(ids("@Ann Lee, thoughts?")).toEqual(["u-annlee"]);
    expect(ids("@Ann, thoughts?")).toEqual(["u-ann"]);
  });

  it("handles single names, hyphens, apostrophes and accents", () => {
    expect(ids("ping @Ann")).toEqual(["u-ann"]);
    expect(ids("@Jean-Luc O'Neill can you check")).toEqual(["u-jean"]);
    expect(ids("@Zoë Müller?")).toEqual(["u-zoe"]);
  });

  it("finds mentions at the start and end of the text, and before punctuation", () => {
    expect(ids("@Alice Johnson approved this")).toEqual(["u-alice"]);
    expect(ids("Assigned to @Alice Johnson")).toEqual(["u-alice"]);
    expect(ids("(@Alice Johnson).")).toEqual(["u-alice"]);
  });

  it("ignores an email address", () => {
    expect(ids("mail me at john@smith.com")).toEqual([]);
  });

  it("ignores users with no name", () => {
    expect(ids("@ hello", [{ id: "u-blank", fullName: "  " }])).toEqual([]);
  });
});
