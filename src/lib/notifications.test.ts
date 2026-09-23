import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted so these are available inside vi.mock factories (which are hoisted)
const { mockInsert, mockSelectChain, mockFrom, tenantUsers, notificationUpdates, chain } =
  vi.hoisted(() => {
    /**
     * A query chain that answers with `result()` whichever method ends it —
     * awaited directly, or after `.in()`. Every step records its arguments.
     */
    function chain(result: () => unknown) {
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "in", "is", "update", "order", "limit"]) {
        c[m] = vi.fn().mockImplementation(() => c);
      }
      c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject);
      return c as Record<string, ReturnType<typeof vi.fn>> & PromiseLike<unknown>;
    }

    const mockInsert = vi.fn().mockResolvedValue({ data: null, error: null });
    const mockSelectChain = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({
        data: [{ userId: "member-1" }, { userId: "member-2" }],
        error: null,
      }),
    };
    /** Rows of `tenant_users` the active-member lookups answer with. */
    const tenantUsers: {
      rows: Array<{ id: string; tenantId: string; isActive: boolean; roleId?: string }>;
    } = { rows: [] };
    const notificationUpdates: unknown[][] = [];

    const mockFrom = vi.fn().mockImplementation((table: string) => {
      if (table === "notifications") {
        const c = chain(() => ({ data: null, error: null }));
        c.update.mockImplementation((v: unknown) => {
          notificationUpdates.push([v]);
          return c;
        });
        return { insert: mockInsert, update: c.update };
      }
      if (table === "approval_group_members") return mockSelectChain;
      if (table === "tenant_users") {
        // Answers the way PostgREST would for `.eq("tenantId").eq("isActive", true)`,
        // optionally `.in("id", [...])`.
        const c = chain(() => {
          const eqs = c.eq.mock.calls as Array<[string, unknown]>;
          const ins = c.in.mock.calls as Array<[string, unknown[]]>;
          let rows = tenantUsers.rows;
          for (const [col, val] of eqs) rows = rows.filter((r) => r[col as "id"] === val);
          for (const [col, list] of ins) {
            rows = rows.filter((r) => list.includes(r[col as "id"]));
          }
          return {
            data: rows.map((r) => ({ id: r.id, roleId: r.roleId, role: { permissions: [] } })),
            error: null,
          };
        });
        return c;
      }
      return { insert: mockInsert };
    });
    return { mockInsert, mockSelectChain, mockFrom, tenantUsers, notificationUpdates, chain };
  });

vi.mock("@/lib/db", () => ({
  getServiceClient: vi.fn().mockReturnValue({ from: mockFrom }),
}));

vi.mock("uuid", () => ({ v4: () => "notif-uuid-1234" }));

// `after` callbacks are collected rather than run, so a test can tell work
// scheduled for after the response from work done inside it.
const { afterCallbacks, mockSendEmail, mockScope } = vi.hoisted(() => ({
  afterCallbacks: [] as (() => unknown)[],
  mockSendEmail: vi.fn(),
  mockScope: vi.fn(),
}));
vi.mock("next/server", () => ({ after: (cb: () => unknown) => afterCallbacks.push(cb) }));
vi.mock("@/lib/email/send", () => ({ sendNotificationEmail: mockSendEmail }));
vi.mock("@/lib/folder-access", async (importActual) => ({
  ...(await importActual<typeof import("./folder-access")>()),
  getFolderAccessScope: mockScope,
}));

import {
  notify,
  notifyApprovalGroupMembers,
  notifyFileTransition,
  clearNotificationsByRef,
} from "./notifications";
import { openScope, type FolderAccessScope } from "./folder-access";

const TENANT = "tenant-1";

/** Everyone the test names is an active member of tenant-1 unless said otherwise. */
function members(...ids: string[]) {
  tenantUsers.rows = ids.map((id) => ({ id, tenantId: TENANT, isActive: true, roleId: "r" }));
}

function insertedUserIds(): string[] {
  const inserted = (mockInsert.mock.calls[0]?.[0] ?? []) as Array<{ userId: string }>;
  return inserted.map((n) => n.userId).sort();
}

function resetMocks() {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  notificationUpdates.length = 0;
  mockInsert.mockResolvedValue({ data: null, error: null });
  mockSelectChain.select.mockReturnThis();
  mockSelectChain.in.mockResolvedValue({
    data: [{ userId: "member-1" }, { userId: "member-2" }],
    error: null,
  });
  members("user-1", "user-2", "user-3", "user-4", "creator-1", "member-1", "member-2");
  mockScope.mockResolvedValue(openScope());
}

/**
 * The vault reads `fileId`. These links were built as `?file=`, so every file
 * transition notification opened the vault root instead of the file.
 */
describe("notifyFileTransition", () => {
  beforeEach(resetMocks);

  const transition = (overrides: Partial<Parameters<typeof notifyFileTransition>[0]> = {}) =>
    notifyFileTransition({
      tenantId: TENANT,
      fileId: "file-42",
      fileName: "bracket.sldprt",
      folderId: "folder-a",
      toStateName: "In Review",
      actorId: "actor-1",
      actorFullName: "Dana",
      createdById: "creator-1",
      ...overrides,
    });

  it("links to the file with the parameter the vault reads", async () => {
    await transition();

    expect(mockInsert).toHaveBeenCalledWith([
      expect.objectContaining({ userId: "creator-1", link: "/vault?fileId=file-42" }),
    ]);
  });

  it("broadcasts a release to every active member when nothing is restricted", async () => {
    tenantUsers.rows.push({ id: "user-gone", tenantId: TENANT, isActive: false });
    tenantUsers.rows.push({ id: "user-elsewhere", tenantId: "tenant-2", isActive: true });

    await transition({ toStateName: "Released" });

    expect(insertedUserIds()).toEqual([
      "creator-1",
      "member-1",
      "member-2",
      "user-1",
      "user-2",
      "user-3",
      "user-4",
    ]);
    // One scope lookup was enough to learn the tenant has no access rules.
    expect(mockScope).toHaveBeenCalledTimes(1);
  });

  /**
   * The broadcast went to every row of tenant_users. In a tenant with
   * restricted folders that named a file, to people who could not open it.
   */
  it("broadcasts a release only to people who can see the folder", async () => {
    members("user-1", "user-2", "user-3");
    const restricted = (allowed: boolean): FolderAccessScope => ({
      bypass: false,
      restrictedAny: true,
      allowed: new Set(allowed ? ["folder-a"] : []),
      editable: new Set(),
      admin: new Set(),
      denied: new Set(),
      restricted: new Set(["folder-a"]),
    });
    mockScope.mockImplementation(async (u: { id: string }) => restricted(u.id !== "user-2"));

    await transition({ toStateName: "Released" });

    expect(insertedUserIds()).toEqual(["user-1", "user-3"]);
  });

  it("leaves out people another notification already reached", async () => {
    members("user-1", "user-2");

    await transition({ toStateName: "Released", excludeUserIds: ["user-2"] });
    expect(insertedUserIds()).toEqual(["user-1"]);

    mockInsert.mockClear();
    await transition({ excludeUserIds: ["creator-1"] });
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe("notify", () => {
  beforeEach(resetMocks);

  it("creates notification records for each user", async () => {
    await notify({
      tenantId: TENANT,
      userIds: ["user-1", "user-2"],
      title: "Test Notification",
      message: "Something happened",
      type: "system",
    });

    expect(mockFrom).toHaveBeenCalledWith("notifications");
    expect(mockInsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          tenantId: TENANT,
          userId: "user-1",
          title: "Test Notification",
          message: "Something happened",
          type: "system",
          isRead: false,
          link: null,
          refId: null,
          actorId: null,
        }),
        expect.objectContaining({
          userId: "user-2",
        }),
      ])
    );
  });

  it("includes link when provided", async () => {
    await notify({
      tenantId: TENANT,
      userIds: ["user-1"],
      title: "Check this",
      message: "Details",
      type: "approval",
      link: "/approvals",
    });

    expect(mockInsert).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ link: "/approvals" })])
    );
  });

  it("stores refId and actorId when provided", async () => {
    await notify({
      tenantId: TENANT,
      userIds: ["user-1"],
      title: "Approved",
      message: "Done",
      type: "approval",
      refId: "request-42",
      actorId: "actor-9",
    });

    expect(mockInsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          userId: "user-1",
          refId: "request-42",
          actorId: "actor-9",
        }),
      ])
    );
  });

  it("filters the actor out of the recipient list", async () => {
    members("user-1", "user-2", "actor-9");
    await notify({
      tenantId: TENANT,
      userIds: ["user-1", "actor-9", "user-2"],
      title: "Heads up",
      message: "Something",
      type: "system",
      actorId: "actor-9",
    });

    expect(insertedUserIds()).toEqual(["user-1", "user-2"]);
  });

  it("does not insert when the only recipient is the actor", async () => {
    await notify({
      tenantId: TENANT,
      userIds: ["actor-9"],
      title: "Self",
      message: "Only me",
      type: "system",
      actorId: "actor-9",
    });

    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("does not insert when userIds is empty", async () => {
    await notify({
      tenantId: TENANT,
      userIds: [],
      title: "No one to notify",
      message: "Ghost message",
      type: "system",
    });

    expect(mockInsert).not.toHaveBeenCalled();
  });

  /**
   * Recipients came straight off join tables — approval_group_members, the
   * ECO approver lookup, the reminder cron — none of which knew whether the
   * person was still active, or even in this tenant. The email sender
   * skipped inactive users; the in-app row was already written.
   */
  it("drops recipients who are inactive or not members of the tenant", async () => {
    tenantUsers.rows = [
      { id: "user-1", tenantId: TENANT, isActive: true },
      { id: "user-gone", tenantId: TENANT, isActive: false },
      { id: "user-elsewhere", tenantId: "tenant-2", isActive: true },
    ];

    await notify({
      tenantId: TENANT,
      userIds: ["user-1", "user-gone", "user-elsewhere", "user-unknown", "user-1"],
      title: "Review",
      message: "Please",
      type: "approval",
    });

    expect(insertedUserIds()).toEqual(["user-1"]);
  });

  it("still notifies everyone asked for when the membership check fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFrom.mockImplementationOnce(() =>
      chain(() => ({ data: null, error: { message: "connection reset" } }))
    );

    await notify({
      tenantId: TENANT,
      userIds: ["user-1", "user-2"],
      title: "Review",
      message: "Please",
      type: "approval",
    });

    expect(insertedUserIds()).toEqual(["user-1", "user-2"]);
  });
});

describe("notifyApprovalGroupMembers", () => {
  beforeEach(resetMocks);

  it("looks up group members and notifies them", async () => {
    await notifyApprovalGroupMembers({
      tenantId: TENANT,
      groupIds: ["group-a"],
      title: "Approval Required",
      message: "Please review",
    });

    // Should query group members
    expect(mockFrom).toHaveBeenCalledWith("approval_group_members");
    expect(mockSelectChain.select).toHaveBeenCalledWith("userId");
    expect(mockSelectChain.in).toHaveBeenCalledWith("groupId", ["group-a"]);

    // Should create notifications for the 2 members
    expect(mockFrom).toHaveBeenCalledWith("notifications");
    expect(mockInsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ userId: "member-1" }),
        expect.objectContaining({ userId: "member-2" }),
      ])
    );
  });

  it("deduplicates members across multiple groups", async () => {
    mockSelectChain.in.mockResolvedValue({
      data: [
        { userId: "member-1" },
        { userId: "member-1" }, // duplicate
        { userId: "member-2" },
      ],
      error: null,
    });

    await notifyApprovalGroupMembers({
      tenantId: TENANT,
      groupIds: ["group-a", "group-b"],
      title: "Review",
      message: "Please",
    });

    // Should only create 2 notifications, not 3
    const insertedNotifs = mockInsert.mock.calls[0][0];
    expect(insertedNotifs).toHaveLength(2);
  });

  it("does nothing when no members found", async () => {
    mockSelectChain.in.mockResolvedValue({ data: [], error: null });

    await notifyApprovalGroupMembers({
      tenantId: TENANT,
      groupIds: ["empty-group"],
      title: "No one here",
      message: "Echo...",
    });

    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("skips a member who has been deactivated", async () => {
    members("member-1");

    await notifyApprovalGroupMembers({
      tenantId: TENANT,
      groupIds: ["group-a"],
      title: "Approval Required",
      message: "Please review",
    });

    expect(insertedUserIds()).toEqual(["member-1"]);
  });
});

/**
 * Clearing a request's "Approval Required" for everyone, not just the
 * person who acted. The rest of an ANY-mode group, a recalled request's
 * approvers and the members of a rejected step all kept theirs unread.
 */
describe("clearNotificationsByRef", () => {
  beforeEach(resetMocks);

  it("marks every unread notification about the entity read, tenant-wide", async () => {
    await clearNotificationsByRef({ tenantId: TENANT, refId: "request-42" });

    expect(mockFrom).toHaveBeenCalledWith("notifications");
    expect(notificationUpdates).toEqual([[{ isRead: true }]]);
  });
});

/**
 * Emails go out after the response, through `after`. They used to be started
 * and left unawaited, and on Vercel an instance can be frozen as soon as the
 * response is returned — taking the unsent emails with it. They were also all
 * started at once, which ran into Resend's 2-a-second limit for any group
 * bigger than two.
 */
describe("notification emails", () => {
  beforeEach(resetMocks);

  it("sends nothing during the request, and hands the emails to after()", async () => {
    mockSendEmail.mockResolvedValue({ ok: true });

    await notify({
      tenantId: TENANT,
      userIds: ["user-1", "user-2"],
      title: "Review",
      message: "Please",
      type: "approval",
    });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);

    await afterCallbacks[0]();
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
  });

  it("sends one email at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mockSendEmail.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return { ok: true };
    });

    await notify({
      tenantId: TENANT,
      userIds: ["user-1", "user-2", "user-3", "user-4"],
      title: "Review",
      message: "Please",
      type: "approval",
    });
    await afterCallbacks[0]();

    expect(mockSendEmail).toHaveBeenCalledTimes(4);
    expect(maxInFlight).toBe(1);
  });

  it("keeps going when one recipient's email fails", async () => {
    mockSendEmail.mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ ok: true });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await notify({
      tenantId: TENANT,
      userIds: ["user-1", "user-2"],
      title: "Review",
      message: "Please",
      type: "approval",
    });
    await afterCallbacks[0]();

    expect(mockSendEmail).toHaveBeenCalledTimes(2);
  });

  it("schedules no emails when the notification rows were not written", async () => {
    mockInsert.mockResolvedValue({ data: null, error: { message: "nope" } });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await notify({
      tenantId: TENANT,
      userIds: ["user-1"],
      title: "Review",
      message: "Please",
      type: "approval",
    });

    expect(afterCallbacks).toHaveLength(0);
  });
});
