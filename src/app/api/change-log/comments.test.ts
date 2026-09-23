import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createFakeSupabase, type FakeSupabase } from "@/lib/__mocks__/fake-supabase";

/**
 * Replies under a post.
 *
 * What is pinned: sales can reply with no permission beyond a session; a
 * reply tells the people in the thread and nobody else, with @mentions on
 * top; and a reply is edited by its author and withdrawn by its author or an
 * admin, soft, like the post above it.
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
vi.mock("@/lib/mentions", () => ({ processMentions: vi.fn().mockResolvedValue(undefined) }));

import { GET } from "./route";
import { POST as REPLY } from "./[postId]/comments/route";
import { PATCH, DELETE } from "./[postId]/comments/[commentId]/route";
import { notify } from "@/lib/notifications";
import { processMentions } from "@/lib/mentions";

const TENANT = "tenant-1";
const POST_ID = "11111111-1111-4111-8111-111111111111";
const REPLY_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_POST = "33333333-3333-4333-8333-333333333333";

const engineer = {
  id: "user-1",
  tenantId: TENANT,
  fullName: "Alice",
  role: { permissions: ["changelog.post"] },
};
/** Sales: read-only everywhere, and the person the thread is for. */
const sam = { ...engineer, id: "user-2", fullName: "Sam", role: { permissions: ["file.view"] } };
const priya = {
  ...engineer,
  id: "user-4",
  fullName: "Priya Nair",
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
const onPost = (postId = POST_ID) => ({ params: Promise.resolve({ postId }) });
const onReply = (commentId = REPLY_ID, postId = POST_ID) => ({
  params: Promise.resolve({ postId, commentId }),
});

const replies = () => state.fake.rows("change_log_comments");

function post(overrides: Record<string, unknown> = {}) {
  return {
    id: POST_ID,
    tenantId: TENANT,
    body: "Bracket now needs the longer screw\nM6x40 instead of M6x30",
    category: "DESIGN",
    authorId: "user-1",
    createdAt: "2026-09-20T10:00:00Z",
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function reply(overrides: Record<string, unknown> = {}) {
  return {
    id: REPLY_ID,
    tenantId: TENANT,
    postId: POST_ID,
    authorId: "user-2",
    body: "Does this affect the order we have in flight for Acme?",
    createdAt: "2026-09-20T11:00:00Z",
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function seed(extra: Record<string, Record<string, unknown>[]> = {}) {
  state.fake = createFakeSupabase({
    change_log_posts: [post()],
    change_log_comments: [],
    change_log_reads: [],
    change_log_files: [],
    tenant_users: [
      { id: "user-1", tenantId: TENANT, fullName: "Alice", isActive: true },
      { id: "user-2", tenantId: TENANT, fullName: "Sam", isActive: true },
      { id: "user-4", tenantId: TENANT, fullName: "Priya Nair", isActive: true },
      { id: "user-5", tenantId: TENANT, fullName: "Ada", isActive: true },
      { id: "user-9", tenantId: "tenant-OTHER", fullName: "Elsewhere", isActive: true },
    ],
    ...extra,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.user = sam;
  seed();
});

describe("POST /api/change-log/[postId]/comments", () => {
  it("lets someone with only a session reply, and tells the post's author", async () => {
    const res = await REPLY(req("POST", { body: "  Does this affect Acme's order?  " }), onPost());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ body: "Does this affect Acme's order?" });
    expect(replies()[0]).toMatchObject({ tenantId: TENANT, postId: POST_ID, authorId: "user-2" });

    const sent = vi.mocked(notify).mock.calls[0][0];
    expect(sent.userIds).toEqual(["user-1"]);
    expect(sent).toMatchObject({
      type: "changelog",
      link: `/change-log?post=${POST_ID}`,
      actorId: "user-2",
    });
    expect(sent.title).toBe("Sam replied on: Bracket now needs the longer screw");
  });

  it("tells everyone already in the thread, and not the rest of the workspace", async () => {
    seed({ change_log_comments: [reply({ authorId: "user-4" })] });
    state.user = engineer;

    await REPLY(req("POST", { body: "No — Acme's order shipped last week." }), onPost());

    const sent = vi.mocked(notify).mock.calls[0][0];
    // Priya replied earlier; Alice is the author and the actor, and notify()
    // drops the actor itself. Ada was never in this thread.
    expect(sent.userIds.sort()).toEqual(["user-1", "user-4"]);
  });

  it("hands @mentions to the mention pipeline, against the same link", async () => {
    await REPLY(req("POST", { body: "@Priya Nair can you confirm the ship date?" }), onPost());

    expect(processMentions).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "change_log_comment",
        mentionedById: "user-2",
        comment: "@Priya Nair can you confirm the ship date?",
        link: `/change-log?post=${POST_ID}`,
      })
    );
  });

  it("refuses a reply to a withdrawn post", async () => {
    seed({ change_log_posts: [post({ deletedAt: "2026-09-21T00:00:00Z" })] });

    const res = await REPLY(req("POST", { body: "?" }), onPost());

    expect(res.status).toBe(404);
    expect(replies()).toHaveLength(0);
  });

  it("refuses a blank reply", async () => {
    const res = await REPLY(req("POST", { body: "   " }), onPost());
    expect(res.status).toBe(400);
  });
});

describe("GET /api/change-log", () => {
  it("returns each post's thread oldest first, without withdrawn replies", async () => {
    seed({
      change_log_posts: [post(), post({ id: OTHER_POST, createdAt: "2026-09-19T10:00:00Z" })],
      change_log_comments: [
        reply({ id: "c-2", createdAt: "2026-09-20T12:00:00Z", body: "second" }),
        reply({ id: "c-1", createdAt: "2026-09-20T11:00:00Z", body: "first" }),
        reply({ id: "c-3", body: "gone", deletedAt: "2026-09-20T13:00:00Z" }),
        reply({ id: "c-4", postId: OTHER_POST, body: "elsewhere" }),
      ],
    });

    const res = await GET(req("GET"), { params: Promise.resolve({}) });
    const { posts } = await res.json();

    expect(posts.map((p: { id: string }) => p.id)).toEqual([POST_ID, OTHER_POST]);
    expect(posts[0].comments.map((c: { body: string }) => c.body)).toEqual(["first", "second"]);
    expect(posts[1].comments.map((c: { body: string }) => c.body)).toEqual(["elsewhere"]);
  });
});

describe("PATCH /api/change-log/[postId]/comments/[commentId]", () => {
  beforeEach(() => seed({ change_log_comments: [reply()] }));

  it("lets the author edit, and marks the edit", async () => {
    const res = await PATCH(
      req("PATCH", { body: "Does this affect Acme's open order?" }),
      onReply()
    );

    expect(res.status).toBe(200);
    expect(replies()[0]).toMatchObject({ body: "Does this affect Acme's open order?" });
    expect(replies()[0].editedAt).toEqual(expect.any(String));
  });

  it("refuses anyone else, including an admin", async () => {
    state.user = admin;
    const res = await PATCH(req("PATCH", { body: "x" }), onReply());
    expect(res.status).toBe(403);
    expect(replies()[0].body).toBe(reply().body);
  });

  it("cannot reach a reply through the wrong post", async () => {
    const res = await PATCH(req("PATCH", { body: "x" }), onReply(REPLY_ID, OTHER_POST));
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/change-log/[postId]/comments/[commentId]", () => {
  beforeEach(() => seed({ change_log_comments: [reply()] }));

  it("withdraws the author's own reply, softly", async () => {
    const res = await DELETE(req("DELETE"), onReply());

    expect(res.status).toBe(200);
    expect(replies()).toHaveLength(1);
    expect(replies()[0].deletedAt).toEqual(expect.any(String));
  });

  it("lets an admin withdraw anyone's reply", async () => {
    state.user = admin;
    const res = await DELETE(req("DELETE"), onReply());
    expect(res.status).toBe(200);
    expect(replies()[0].deletedAt).toEqual(expect.any(String));
  });

  it("refuses another member", async () => {
    state.user = priya;
    const res = await DELETE(req("DELETE"), onReply());
    expect(res.status).toBe(403);
    expect(replies()[0].deletedAt).toBeNull();
  });

  it("answers 404 for a reply already withdrawn", async () => {
    seed({ change_log_comments: [reply({ deletedAt: "2026-09-21T00:00:00Z" })] });
    const res = await DELETE(req("DELETE"), onReply());
    expect(res.status).toBe(404);
  });
});
