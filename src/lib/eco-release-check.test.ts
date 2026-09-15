import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFakeSupabase, type FakeSupabase } from "@/lib/__mocks__/fake-supabase";

/**
 * `implement_eco` releases listed files and files linked to listed parts, but
 * only ones it finds in WIP and not checked out — anything else it skipped
 * without saying so, and it released trashed files and parts. The ECO went to
 * IMPLEMENTED either way. This names all of that before it can happen.
 */

const state = vi.hoisted(() => ({ fake: null as unknown as FakeSupabase }));
vi.mock("@/lib/db", () => ({ getServiceClient: () => state.fake.client }));

import { checkEcoRelease, describeBlockers } from "./eco-release-check";

const TENANT = "tenant-a";

function file(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    tenantId: TENANT,
    name: `${id}.SLDDRW`,
    lifecycleState: "WIP",
    isCheckedOut: false,
    deletedAt: null,
    createdById: "user-1",
    checkedOutBy: null,
    ...extra,
  };
}

beforeEach(() => {
  state.fake = createFakeSupabase({
    eco_items: [
      { id: "i-1", ecoId: "eco-1", fileId: "bracket", partId: null },
      { id: "i-2", ecoId: "eco-1", fileId: null, partId: "part-1" },
    ],
    parts: [{ id: "part-1", tenantId: TENANT, partNumber: "PN-1042", deletedAt: null }],
    part_files: [{ id: "pf-1", partId: "part-1", fileId: "plate" }],
    files: [file("bracket"), file("plate")],
  });
});

const files = () => state.fake.tables.files;

describe("checkEcoRelease", () => {
  it("releases listed and part-linked files in WIP, with nothing blocking", async () => {
    const plan = await checkEcoRelease(TENANT, "eco-1", "implement");
    expect(plan.blockers).toEqual([]);
    expect(plan.filesToRelease.map((f) => f.id).sort()).toEqual(["bracket", "plate"]);
  });

  it("does not count an already released file as a release, nor block on it", async () => {
    files()[0].lifecycleState = "Released";
    const plan = await checkEcoRelease(TENANT, "eco-1", "implement");
    expect(plan.blockers).toEqual([]);
    expect(plan.filesToRelease.map((f) => f.id)).toEqual(["plate"]);
  });

  it("names a checked-out file and who holds it", async () => {
    Object.assign(files()[0], { isCheckedOut: true, checkedOutBy: { fullName: "Bob" } });

    const atSubmit = await checkEcoRelease(TENANT, "eco-1", "submit");
    const atImplement = await checkEcoRelease(TENANT, "eco-1", "implement");

    expect(atSubmit.blockers).toEqual([
      expect.stringMatching(/bracket.SLDDRW is checked out by Bob. Check it in first/),
    ]);
    expect(atImplement.blockers).toEqual([expect.stringMatching(/Undo the checkout/)]);
    expect(atImplement.filesToRelease.map((f) => f.id)).toEqual(["plate"]);
  });

  it("names a file in a state implement would leave untouched, and which part it came through", async () => {
    files()[1].lifecycleState = "In Review";
    const plan = await checkEcoRelease(TENANT, "eco-1", "submit");
    expect(plan.blockers).toEqual([
      expect.stringMatching(
        /plate.SLDDRW \(linked to PN-1042\) is In Review.*unlink it from PN-1042/
      ),
    ]);
  });

  it("names files and parts in the trash", async () => {
    files()[0].deletedAt = "2026-09-01T00:00:00Z";
    state.fake.tables.parts[0].deletedAt = "2026-09-01T00:00:00Z";
    const plan = await checkEcoRelease(TENANT, "eco-1", "implement");
    expect(plan.blockers).toEqual(
      expect.arrayContaining([
        "Part PN-1042 is in the trash. Restore it, or remove it from the ECO.",
        expect.stringMatching(/bracket.SLDDRW is in the trash/),
      ])
    );
  });

  it("names a file whose own lifecycle change is awaiting approval", async () => {
    state.fake.tables.approval_requests = [
      { id: "r-1", tenantId: TENANT, entityType: "file", entityId: "plate", status: "PENDING" },
    ];
    const plan = await checkEcoRelease(TENANT, "eco-1", "submit");
    expect(plan.blockers).toEqual([expect.stringMatching(/plate.SLDDRW.*awaiting approval/)]);
  });

  it("does not read another tenant's files", async () => {
    files()[0].tenantId = "tenant-b";
    files()[0].deletedAt = "2026-09-01T00:00:00Z";
    const plan = await checkEcoRelease(TENANT, "eco-1", "implement");
    expect(plan.blockers).toEqual([]);
  });
});

describe("describeBlockers", () => {
  it("shows the first four and counts the rest", () => {
    const message = describeBlockers("ECO-1 cannot be submitted yet", [
      "A.",
      "B.",
      "C.",
      "D.",
      "E.",
      "F.",
    ]);
    expect(message).toBe(
      "ECO-1 cannot be submitted yet: A. B. C. D. And 2 more — see the details."
    );
  });
});
