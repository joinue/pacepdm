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

import { notify, notifyApprovalGroupMembers } from "./notifications";

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
      expect.arrayContaining([
        expect.objectContaining({ link: "/approvals" }),
      ])
    );
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
