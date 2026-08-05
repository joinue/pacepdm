import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BOM_STATUS_FLOW,
  BOM_STATES_RELEASABLE_BY_ECO,
  bomCanBeReleasedByEco,
  bomCanTransition,
  ecoCanTransition,
} from "./status-flows";

const MIGRATION = readFileSync(
  join(__dirname, "..", "..", "supabase", "migrations", "migration-049-implement-eco-boms.sql"),
  "utf8"
);

describe("BOM status flow", () => {
  it("allows the normal review path", () => {
    expect(bomCanTransition("DRAFT", "IN_REVIEW")).toBe(true);
    expect(bomCanTransition("APPROVED", "RELEASED")).toBe(true);
  });

  it("does not allow a draft to be released directly", () => {
    expect(bomCanTransition("DRAFT", "RELEASED")).toBe(false);
  });

  it("treats OBSOLETE as terminal", () => {
    expect(BOM_STATUS_FLOW.OBSOLETE).toEqual([]);
  });
});

describe("ECO status flow", () => {
  it("only reaches IMPLEMENTED from APPROVED", () => {
    expect(ecoCanTransition("APPROVED", "IMPLEMENTED")).toBe(true);
    expect(ecoCanTransition("SUBMITTED", "IMPLEMENTED")).toBe(false);
  });
});

/**
 * `implement_eco` releases a BOM from a wider set of statuses than
 * BOM_STATUS_FLOW allows, because the ECO's approval is the review. That
 * exception is written in two places — this constant and the PL/pgSQL in
 * migration 049 — and the whole point of the constant is that the two stay
 * in agreement. These tests read the migration text so editing one without
 * the other fails the build.
 */
describe("BOM release by ECO implementation", () => {
  it("covers exactly the pre-release statuses", () => {
    expect([...BOM_STATES_RELEASABLE_BY_ECO]).toEqual(["DRAFT", "IN_REVIEW", "APPROVED"]);
    expect(bomCanBeReleasedByEco("DRAFT")).toBe(true);
    expect(bomCanBeReleasedByEco("IN_REVIEW")).toBe(true);
    expect(bomCanBeReleasedByEco("APPROVED")).toBe(true);
  });

  it("excludes RELEASED and OBSOLETE, which the function handles separately", () => {
    expect(bomCanBeReleasedByEco("RELEASED")).toBe(false);
    expect(bomCanBeReleasedByEco("OBSOLETE")).toBe(false);
  });

  it("is deliberately wider than the hand-driven flow", () => {
    // If this ever stops being true, the constant is redundant and should
    // be deleted rather than left as a second copy of the same rule.
    const widerThanFlow = BOM_STATES_RELEASABLE_BY_ECO.some(
      (s) => !(BOM_STATUS_FLOW[s] || []).includes("RELEASED")
    );
    expect(widerThanFlow).toBe(true);
  });

  it("matches how migration 049 branches", () => {
    // RELEASED is counted, not released again.
    expect(MIGRATION).toMatch(/v_bom\."status" = 'RELEASED'/);
    expect(MIGRATION).toMatch(/v_boms_already := v_boms_already \+ 1/);
    // OBSOLETE raises rather than being skipped.
    expect(MIGRATION).toMatch(/v_bom\."status" = 'OBSOLETE'/);
    expect(MIGRATION).toMatch(/RAISE EXCEPTION[\s\S]{0,200}OBSOLETE/);
    // Everything else releases and supersedes its predecessor.
    expect(MIGRATION).toMatch(/SET "status" = 'RELEASED'/);
    expect(MIGRATION).toMatch(/"supersededById" = v_bom\."id"/);
  });

  it("keeps the eco_items target constraint covering all three columns", () => {
    // The bug migration 049 fixes: 046 added bomId but left migration 017's
    // two-column XOR in place, so a BOM-only row failed the CHECK.
    expect(MIGRATION).toMatch(/DROP CONSTRAINT IF EXISTS "eco_items_target_xor"/);
    expect(MIGRATION).toMatch(/"bomId"\s+IS NOT NULL THEN 1 ELSE 0 END/);
  });
});
