import { describe, it, expect, vi } from "vitest";
import { createFakeSupabase, type FakeSupabase } from "@/lib/__mocks__/fake-supabase";

/**
 * A change order releases what it carries as it stands when implemented, so
 * that content has to stay put from submission until then. Only a file's own
 * pending lifecycle approval used to lock it: a drawing checked in after its
 * ECO was approved was what got released, unreviewed (AUD-003 CHG-2).
 */

const state = vi.hoisted(() => ({ fake: null as unknown as FakeSupabase }));
vi.mock("@/lib/db", () => ({ getServiceClient: () => state.fake.client }));

import { fileChangeRefusal, lockingEcoForFile, lockingEcoForPart } from "./eco-content-lock";

const TENANT = "tenant-a";

function seed(ecoStatus: string, extra: Record<string, unknown[]> = {}) {
  state.fake = createFakeSupabase({
    ecos: [
      { id: "eco-1", tenantId: TENANT, ecoNumber: "ECO-0042", status: ecoStatus, deletedAt: null },
    ],
    eco_items: [
      { id: "i-1", ecoId: "eco-1", fileId: "drawing", partId: null },
      { id: "i-2", ecoId: "eco-1", fileId: null, partId: "part-1" },
    ],
    part_files: [{ id: "pf-1", partId: "part-1", fileId: "model" }],
    ...(extra as Record<string, Record<string, unknown>[]>),
  });
}

describe("lockingEcoForFile", () => {
  it.each(["SUBMITTED", "IN_REVIEW", "APPROVED"])(
    "locks a file listed on an ECO that is %s",
    async (status) => {
      seed(status);
      expect(await lockingEcoForFile(TENANT, "drawing")).toMatchObject({ ecoNumber: "ECO-0042" });
    }
  );

  it("locks a file linked to a part the ECO lists", async () => {
    seed("APPROVED");
    expect(await lockingEcoForFile(TENANT, "model")).toMatchObject({ id: "eco-1" });
  });

  it.each(["DRAFT", "REJECTED", "IMPLEMENTED", "CLOSED"])(
    "does not lock while the ECO is %s",
    async (status) => {
      seed(status);
      expect(await lockingEcoForFile(TENANT, "drawing")).toBeNull();
    }
  );

  it("ignores a deleted ECO", async () => {
    seed("APPROVED");
    state.fake.tables.ecos[0].deletedAt = "2026-09-01T00:00:00Z";
    expect(await lockingEcoForFile(TENANT, "drawing")).toBeNull();
  });

  it("ignores an ECO in another tenant", async () => {
    seed("APPROVED");
    state.fake.tables.ecos[0].tenantId = "tenant-b";
    expect(await lockingEcoForFile(TENANT, "drawing")).toBeNull();
  });

  it("does not lock a file nothing carries", async () => {
    seed("APPROVED");
    expect(await lockingEcoForFile(TENANT, "unrelated")).toBeNull();
  });
});

describe("lockingEcoForPart", () => {
  it("locks the file links of a part an approved ECO lists", async () => {
    seed("APPROVED");
    expect(await lockingEcoForPart(TENANT, "part-1")).toMatchObject({ ecoNumber: "ECO-0042" });
  });

  it("leaves a draft ECO's part editable", async () => {
    seed("DRAFT");
    expect(await lockingEcoForPart(TENANT, "part-1")).toBeNull();
  });
});

describe("fileChangeRefusal", () => {
  it("names the ECO and what it will do", async () => {
    seed("APPROVED");
    const refusal = await fileChangeRefusal(TENANT, "drawing", "checked out");
    expect(refusal).toMatch(/on ECO-0042, which is Approved and will release it as it stands/);
    expect(refusal).toMatch(/cannot be checked out until the ECO is implemented/);
  });

  it("still refuses a file awaiting its own lifecycle approval", async () => {
    seed("DRAFT", {
      approval_requests: [
        {
          id: "req-1",
          tenantId: TENANT,
          entityType: "file",
          entityId: "drawing",
          status: "PENDING",
          title: "Release drawing",
        },
      ],
    });
    expect(await fileChangeRefusal(TENANT, "drawing", "renamed")).toMatch(/awaiting approval/);
  });

  it("allows a change nothing locks", async () => {
    seed("DRAFT");
    expect(await fileChangeRefusal(TENANT, "drawing", "renamed")).toBeNull();
  });
});
