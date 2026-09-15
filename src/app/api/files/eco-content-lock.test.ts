import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createFakeSupabase, type FakeSupabase } from "@/lib/__mocks__/fake-supabase";

/**
 * Every route that changes what an approved ECO will release asks the same
 * lock. The rule this codebase keeps relearning is that a guard applied to one
 * of the paths that need it is not a guard, so each path is exercised here:
 * checkout (and so check-in), the trash, a lifecycle transition, and changing
 * a carried part's file links (AUD-003 CHG-2).
 */

const state = vi.hoisted(() => ({
  fake: null as unknown as FakeSupabase,
  user: null as null | Record<string, unknown>,
}));

vi.mock("@/lib/db", () => ({ getServiceClient: () => state.fake.client }));
vi.mock("@/lib/auth", async () => {
  const perms = await vi.importActual<typeof import("@/lib/permissions")>("@/lib/permissions");
  return {
    getApiTenantUser: () => Promise.resolve(state.user),
    hasPermission: perms.hasPermission,
    PERMISSIONS: perms.PERMISSIONS,
  };
});
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/folder-access", async () => {
  const actual = await vi.importActual<typeof import("@/lib/folder-access")>("@/lib/folder-access");
  return { ...actual, getFolderAccessScope: vi.fn(async () => actual.openScope()) };
});

import { POST as checkout } from "./[fileId]/checkout/route";
import { DELETE as trash } from "./[fileId]/delete/route";
import { POST as transition } from "./[fileId]/transition/route";
import { POST as linkFile, DELETE as unlinkFile } from "../parts/[partId]/files/route";

const TENANT = "tenant-a";
const FILE_ID = "f1f1f1f1-1111-4111-8111-000000000001";
const PART_ID = "a1a1a1a1-1111-4111-8111-000000000001";

function seed(ecoStatus: string) {
  state.fake = createFakeSupabase({
    ecos: [
      { id: "eco-1", tenantId: TENANT, ecoNumber: "ECO-0042", status: ecoStatus, deletedAt: null },
    ],
    eco_items: [
      { id: "i-1", ecoId: "eco-1", fileId: FILE_ID, partId: null },
      { id: "i-2", ecoId: "eco-1", fileId: null, partId: PART_ID },
    ],
    files: [
      {
        id: FILE_ID,
        tenantId: TENANT,
        folderId: "folder-1",
        name: "bracket.SLDDRW",
        lifecycleState: "WIP",
        lifecycleId: null,
        isFrozen: false,
        isCheckedOut: false,
        checkedOutById: null,
        deletedAt: null,
      },
    ],
    parts: [{ id: PART_ID, tenantId: TENANT, partNumber: "PN-1042" }],
  });
}

const fileParams = { params: Promise.resolve({ fileId: FILE_ID }) };
const partParams = { params: Promise.resolve({ partId: PART_ID }) };
const json = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  state.user = {
    id: "user-1",
    tenantId: TENANT,
    fullName: "Alice",
    roleId: "role-admin",
    role: { permissions: ["*"] },
  };
});

describe("a file on an approved ECO", () => {
  beforeEach(() => seed("APPROVED"));

  it("cannot be checked out, which is how a new version would get in", async () => {
    const res = await checkout(json("POST"), fileParams);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/on ECO-0042, which is Approved/);
    expect(state.fake.tables.files[0].isCheckedOut).toBe(false);
  });

  it("cannot be moved to the trash, from where implement used to release it", async () => {
    const res = await trash(json("DELETE"), fileParams);
    expect(res.status).toBe(409);
    expect(state.fake.tables.files[0].deletedAt).toBeNull();
  });

  it("cannot be moved to another lifecycle state by hand", async () => {
    const res = await transition(json("POST", { transitionId: "t-1" }), fileParams);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/moved to another lifecycle state/);
  });
});

describe("a part on an approved ECO", () => {
  beforeEach(() => seed("APPROVED"));

  it("cannot be given a new file, which implement would release unreviewed", async () => {
    const res = await linkFile(json("POST", { fileId: FILE_ID, role: "DRAWING" }), partParams);
    expect(res.status).toBe(409);
    expect(state.fake.rows("part_files")).toHaveLength(0);
  });

  it("cannot lose a file the reviewers approved", async () => {
    state.fake.tables.part_files = [{ id: "pf-1", partId: PART_ID, fileId: FILE_ID }];
    const res = await unlinkFile(json("DELETE", { fileId: FILE_ID }), partParams);
    expect(res.status).toBe(409);
    expect(state.fake.rows("part_files")).toHaveLength(1);
  });
});

describe("the same file and part while the ECO is still a draft", () => {
  beforeEach(() => seed("DRAFT"));

  it("can be checked out", async () => {
    const res = await checkout(json("POST"), fileParams);
    expect(res.status).toBe(200);
  });

  it("can be moved to the trash", async () => {
    const res = await trash(json("DELETE"), fileParams);
    expect(res.status).toBe(200);
  });
});
