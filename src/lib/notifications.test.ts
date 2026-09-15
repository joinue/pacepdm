import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted so these are available inside vi.mock factories (which are hoisted)
const { mockInsert, mockSelectChain, mockFrom } = vi.hoisted(() => {
  const mockInsert = vi.fn().mockResolvedValue({ data: null, error: null });
  const mockSelectChain = {
    select: vi.fn().mockReturnThis(),
    in: vi.fn().mockResolvedValue({
      data: [{ userId: "member-1" }, { userId: "member-2" }],
      error: null,
    }),
  };
  const mockFrom = vi.fn().mockImplementation((table: string) => {
    if (table === "notifications") return { insert: mockInsert };
    if (table === "approval_group_members") return mockSelectChain;
    return { insert: mockInsert };
  });
  return { mockInsert, mockSelectChain, mockFrom };
});

vi.mock("@/lib/db", () => ({
  getServiceClient: vi.fn().mockReturnValue({ from: mockFrom }),
}));

vi.mock("uuid", () => ({ v4: () => "notif-uuid-1234" }));

// `after` callbacks are collected rather than run, so a test can tell work
// scheduled for after the response from work done inside it.
const { afterCallbacks, mockSendEmail } = vi.hoisted(() => ({
  afterCallbacks: [] as (() => unknown)[],
  mockSendEmail: vi.fn(),
}));
vi.mock("next/server", () => ({ after: (cb: () => unknown) => afterCallbacks.push(cb) }));
vi.mock("@/lib/email/send", () => ({ sendNotificationEmail: mockSendEmail }));

import { notify, notifyApprovalGroupMembers, notifyFileTransition } from "./notifications";

/**
 * The vault reads `fileId`. These links were built as `?file=`, so every file
 * transition notification opened the vault root instead of the file.
 */
describe("notifyFileTransition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockResolvedValue({ data: null, error: null });
    mockFrom.mockImplementation(() => ({ insert: mockInsert }));
  });

  it("links to the file with the parameter the vault reads", async () => {
    await notifyFileTransition({
      tenantId: "tenant-1",
      fileId: "file-42",
      fileName: "bracket.sldprt",
      toStateName: "In Review",
      actorId: "actor-1",
      actorFullName: "Dana",
      createdById: "creator-1",
    });

    expect(mockInsert).toHaveBeenCalledWith([
      expect.objectContaining({ userId: "creator-1", link: "/vault?fileId=file-42" }),
    ]);
  });
});

describe("notify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-setup mockFrom implementations after clear
    mockFrom.mockImplementation((table: string) => {
      if (table === "notifications") return { insert: mockInsert };
      if (table === "approval_group_members") return mockSelectChain;
      return { insert: mockInsert };
    });
    mockSelectChain.select.mockReturnThis();
    mockSelectChain.in.mockResolvedValue({
      data: [{ userId: "member-1" }, { userId: "member-2" }],
      error: null,
    });
  });

  it("creates notification records for each user", async () => {
    await notify({
      tenantId: "tenant-1",
      userIds: ["user-1", "user-2"],
      title: "Test Notification",
      message: "Something happened",
      type: "system",
    });

    expect(mockFrom).toHaveBeenCalledWith("notifications");
    expect(mockInsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          tenantId: "tenant-1",
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
      tenantId: "tenant-1",
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
      tenantId: "tenant-1",
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
    await notify({
      tenantId: "tenant-1",
      userIds: ["user-1", "actor-9", "user-2"],
      title: "Heads up",
      message: "Something",
      type: "system",
      actorId: "actor-9",
    });

    const inserted = mockInsert.mock.calls[0][0] as Array<{ userId: string }>;
    expect(inserted.map((n) => n.userId).sort()).toEqual(["user-1", "user-2"]);
  });

  it("does not insert when the only recipient is the actor", async () => {
    await notify({
      tenantId: "tenant-1",
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
      tenantId: "tenant-1",
      userIds: [],
      title: "No one to notify",
      message: "Ghost message",
      type: "system",
    });

    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe("notifyApprovalGroupMembers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation((table: string) => {
      if (table === "notifications") return { insert: mockInsert };
      if (table === "approval_group_members") return mockSelectChain;
      return { insert: mockInsert };
    });
    mockSelectChain.select.mockReturnThis();
    mockSelectChain.in.mockResolvedValue({
      data: [{ userId: "member-1" }, { userId: "member-2" }],
      error: null,
    });
  });

  it("looks up group members and notifies them", async () => {
    await notifyApprovalGroupMembers({
      tenantId: "tenant-1",
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
      tenantId: "tenant-1",
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
      tenantId: "tenant-1",
      groupIds: ["empty-group"],
      title: "No one here",
      message: "Echo...",
    });

    expect(mockInsert).not.toHaveBeenCalled();
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
  beforeEach(() => {
    vi.clearAllMocks();
    afterCallbacks.length = 0;
    mockFrom.mockImplementation(() => ({ insert: mockInsert }));
    mockInsert.mockResolvedValue({ data: null, error: null });
  });

  it("sends nothing during the request, and hands the emails to after()", async () => {
    mockSendEmail.mockResolvedValue({ ok: true });

    await notify({
      tenantId: "tenant-1",
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
      tenantId: "tenant-1",
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
      tenantId: "tenant-1",
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
      tenantId: "tenant-1",
      userIds: ["user-1"],
      title: "Review",
      message: "Please",
      type: "approval",
    });

    expect(afterCallbacks).toHaveLength(0);
  });
});
