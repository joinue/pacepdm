import { describe, it, expect } from "vitest";
import { ilikeContains } from "./validation";

/**
 * `.or()` is the one Supabase builder that takes a raw filter string, so an
 * interpolated search term is parsed as syntax rather than treated as a value.
 *
 * The comma is what bites: `or=(name.ilike.*a,b*)` reads the comma as the
 * separator between two conditions and the remainder fails to parse — PGRST100,
 * surfaced to the user as a 500. Part descriptions routinely contain commas
 * ("M6, 20mm"), so this broke ordinary searches, in five places.
 *
 * Confirmed against the live database while fixing: a `)` does NOT escape the
 * `or=(...)` group, and no term reaches another tenant's rows, because the
 * tenant filter is a separate `.eq()` that PostgREST ANDs with the group. So
 * this is robustness, not isolation.
 */
describe("ilikeContains", () => {
  it("wraps the term in wildcards inside quotes", () => {
    expect(ilikeContains("bracket")).toBe('"%bracket%"');
  });

  it("survives a comma — the case that 500'd the search", () => {
    expect(ilikeContains("M6, 20mm")).toBe('"%M6, 20mm%"');
  });

  it("survives parens and dots, which are also filter syntax", () => {
    expect(ilikeContains("N1S-M-001 (rev R2)")).toBe('"%N1S-M-001 (rev R2)%"');
    expect(ilikeContains("a.b.c")).toBe('"%a.b.c%"');
  });

  it("escapes a double quote so the term cannot close its own quoting", () => {
    expect(ilikeContains('say "hi"')).toBe('"%say \\"hi\\"%"');
  });

  it("escapes backslashes before quotes, so an escaped quote cannot be faked", () => {
    // A term ending in a backslash would otherwise escape the closing quote.
    expect(ilikeContains("path\\")).toBe('"%path\\\\%"');
    expect(ilikeContains('x\\"y')).toBe('"%x\\\\\\"y%"');
  });

  it("handles an empty term without producing broken syntax", () => {
    expect(ilikeContains("")).toBe('"%%"');
  });
});
