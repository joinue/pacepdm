import { getServiceClient } from "@/lib/db";

// In-app notification system. Email can be added later via Resend/SES.
// For now, we store notifications in the database and show them in the UI.

export async function notify({
  tenantId,
  userIds,
  title,
  message,
  type,
  link,
}: {
  tenantId: string;
  userIds: string[];
  title: string;
  message: string;
  type: "approval" | "transition" | "checkout" | "eco" | "system";
  link?: string;
}) {
  const db = getServiceClient();
  const now = new Date().toISOString();
  const { v4: uuid } = await import("uuid");

  const notifications = userIds.map((userId) => ({
    id: uuid(),
    tenantId,
    userId,
    title,
    message,
    type,
    link: link || null,
    isRead: false,
    createdAt: now,
  }));

  if (notifications.length > 0) {
    await db.from("notifications").insert(notifications);
  }
}

export async function notifyApprovalGroupMembers({
  tenantId,
  groupIds,
  title,
  message,
  link,
}: {
  tenantId: string;
  groupIds: string[];
  title: string;
  message: string;
  link?: string;
}) {
  const db = getServiceClient();

  // Get all unique members across the groups
  const { data: members } = await db
    .from("approval_group_members")
    .select("userId")
    .in("groupId", groupIds);

  const uniqueUserIds = [...new Set((members || []).map((m) => m.userId))];

  if (uniqueUserIds.length > 0) {
    await notify({
      tenantId,
      userIds: uniqueUserIds,
      title,
      message,
      type: "approval",
      link,
    });
  }
}
