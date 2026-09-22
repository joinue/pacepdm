import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createFakeSupabase, type FakeSupabase } from "@/lib/__mocks__/fake-supabase";

/**
 * The change log. Engineering changes something, sales hears about it from a
 * customer — so a post tells everyone, and who has read it is recorded.
 *
 * The rule worth pinning: a post is a notice. Sales reads and acknowledges it
 * with no permission beyond a session, and posting is gated. Nothing here
 * approves anything.
 */

const state = vi.hoisted(() => ({
  fake: null as unknown as FakeSupabase,
  user: null as null | Record<string, unknown>,
}));

vi.mock("@/lib/db", () => ({ getServiceClient: () => state.fake.client }));
vi.mock("@/lib/auth", () => ({ getApiTenantUser: () => Promise.resolve(state.user) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/notifications", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
  sideEffect: (p: Promise<unknown>) => p,
}));

import { GET, POST } from "./route";
import { PATCH, DELETE } from "./[postId]/route";
import { POST as MARK_READ } from "./[postId]/read/route";
import { notify } from "@/lib/notifications";

const TENANT = "tenant-1";
const POST_ID = "11111111-1111-4111-8111-111111111111";
const postParams = { params: Promise.resolve({ postId: POST_ID }) };
const noParams = { params: Promise.resolve({}) };

const engineer = {
  id: "user-1",
  tenantId: TENANT,
  fullName: "Alice",
  roleId: "role-eng",
  role: { permissions: ["changelog.post"] },
};
/** Sales: read-only everywhere, which still reads and acknowledges the feed. */
const salesperson = {
  ...engineer,
  id: "user-2",
  fullName: "Sam",
  roleId: "role-sales",
  role: { permissions: ["file.view"] },
};
const admin = { ...engineer, id: "user-5", fullName: "Ada", role: { permissions: ["*"] } };

function req(method: string, body?: unknown) {
  return new NextRequest("http://localhost/api/change-log", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const posts = () => state.fake.rows("change_log_posts");
const reads = () => state.fake.rows("change_log_reads");

function seed(extra: Record<string, Record<string, unknown>[]> = {}) {
  state.fake = createFakeSupabase({
    change_log_posts: [],
    change_log_reads: [],
    change_log_files: [],
    tenant_users: [
      { id: "user-1", tenantId: TENANT, fullName: "Alice", isActive: true },
      { id: "user-2", tenantId: TENANT, fullName: "Sam", isActive: true },
      { id: "user-3", tenantId: TENANT, fullName: "Gone", isActive: false },
      { id: "user-9", tenantId: "tenant-OTHER", fullName: "Elsewhere", isActive: true },
    ],
    ...extra,
  });
}

/** A post already in the feed. */
function existingPost(overrides: Record<string, unknown> = {}) {
  return {
    id: POST_ID,
    tenantId: TENANT,
    body: "Bracket now needs the longer screw",
    category: "DESIGN",
    authorId: "user-1",
    partId: null,
    fileId: null,
    ecoId: null,
    releaseId: null,
    createdAt: "2026-09-20T10:00:00Z",
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.user = engineer;
  seed();
});

describe("POST /api/change-log", () => {
  it("posts, and tells everyone active in the workspace", async () => {
    const res = await POST(
      req("POST", { body: "Bracket now needs the longer screw", category: "DESIGN" }),
      noParams
    );

    expect(res.status).toBe(200);
    expect(posts()[0]).toMatchObject({ category: "DESIGN", authorId: "user-1" });

    const sent = vi.mocked(notify).mock.calls[0][0];
    expect(sent.userIds.sort()).toEqual(["user-1", "user-2"]);
    expect(sent).toMatchObject({ type: "changelog", link: "/change-log" });
    expect(sent.title).toMatch(/Design change: Bracket now needs the longer screw/);
  });

  it("refuses someone who can only read the feed", async () => {
    state.user = salesperson;
    const res = await POST(req("POST", { body: "..." }), noParams);
    expect(res.status).toBe(403);
    expect(posts()).toHaveLength(0);
  });

  it("refuses a category the feed does not have", async () => {
    const res = await POST(req("POST", { body: "x", category: "RUMOUR" }), noParams);
    expect(res.status).toBe(400);
  });

  it("refuses a post with nothing in it", async () => {
    const res = await POST(req("POST", { body: "   \n  " }), noParams);
    expect(res.status).toBe(400);
  });

  it("defaults the category when none is given", async () => {
    await POST(req("POST", { body: "Shop floor moved the paint booth" }), noParams);
    expect(posts()[0].category).toBe("GENERAL");
  });
});

describe("GET /api/change-log", () => {
  beforeEach(() => {
    seed({
      change_log_posts: [existingPost()],
      change_log_reads: [
        { postId: POST_ID, userId: "user-2", tenantId: TENANT, readAt: "2026-09-20T12:00:00Z" },
      ],
      change_log_files: [
        {
          id: "file-1",
          tenantId: TENANT,
          postId: POST_ID,
          storageKey: "change-log/x.pdf",
          fileName: "spec.pdf",
          sizeBytes: 1024,
        },
      ],
    });
  });

  it("gives sales the feed, its attachments and who has read each post", async () => {
    state.user = salesperson;
    const body = await (await GET(req("GET"), noParams)).json();

    expect(body.posts).toHaveLength(1);
    expect(body.posts[0].attachments[0]).toMatchObject({ fileName: "spec.pdf" });
    expect(body.posts[0].readBy).toHaveLength(1);
    // Sam has read it; Alice would see readByMe false.
    expect(body.posts[0].readByMe).toBe(true);
  });

  it("hides a withdrawn post", async () => {
    state.fake.tables.change_log_posts[0].deletedAt = "2026-09-21T00:00:00Z";
    const body = await (await GET(req("GET"), noParams)).json();
    expect(body.posts).toHaveLength(0);
  });

  it("does not show another workspace's feed", async () => {
    state.fake.tables.change_log_posts[0].tenantId = "tenant-OTHER";
    const body = await (await GET(req("GET"), noParams)).json();
    expect(body.posts).toHaveLength(0);
  });
});

describe("marking a post read", () => {
  beforeEach(() => seed({ change_log_posts: [existingPost()] }));

  it("records the receipt for someone with no permissions at all", async () => {
    state.user = salesperson;
    const res = await MARK_READ(req("POST"), postParams);

    expect(res.status).toBe(200);
    expect(reads()[0]).toMatchObject({ postId: POST_ID, userId: "user-2" });
  });

  it("writes one row however many times it is clicked", async () => {
    state.user = salesperson;
    await MARK_READ(req("POST"), postParams);
    await MARK_READ(req("POST"), postParams);
    expect(reads()).toHaveLength(1);
  });
});

describe("editing and withdrawing", () => {
  beforeEach(() => seed({ change_log_posts: [existingPost()] }));

  it("marks an edit, because people argue from this feed", async () => {
    const res = await PATCH(
      req("PATCH", { body: "Bracket needs the M4x20, not the M4x16" }),
      postParams
    );

    expect(res.status).toBe(200);
    expect(posts()[0].body).toBe("Bracket needs the M4x20, not the M4x16");
    expect(posts()[0].editedAt).toBeTruthy();
  });

  it("lets nobody else edit someone's words", async () => {
    state.user = { ...admin, role: { permissions: ["changelog.post"] } };
    const res = await PATCH(req("PATCH", { body: "different" }), postParams);
    expect(res.status).toBe(403);
    expect(posts()[0].body).toBe("Bracket now needs the longer screw");
  });

  it("withdraws a post without destroying what was said", async () => {
    const res = await DELETE(req("DELETE"), postParams);
    expect(res.status).toBe(200);
    expect(posts()).toHaveLength(1);
    expect(posts()[0].deletedAt).toBeTruthy();
  });

  it("lets an admin withdraw someone else's post", async () => {
    state.user = admin;
    expect((await DELETE(req("DELETE"), postParams)).status).toBe(200);
  });
});
