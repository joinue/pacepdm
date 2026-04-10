import { getServiceClient } from "@/lib/db";

/**
 * Wrap a promise that represents a non-critical side effect
 * (notifications, mention processing, etc.) so failures are *logged*
 * rather than silently swallowed. The main flow always continues.
 *
 * Use instead of `.catch(() => {})`:
 *   await sideEffect(notify({...}), "notify ECO submitter");
 */
export async function sideEffect<T>(
  promise: Promise<T>,
  context: string
): Promise<T | undefined> {
  try {
    return await promise;
  } catch (err) {
    console.error(`[side-effect failed] ${context}:`, err);
    return undefined;
  }
}

// In-app notification system. Email can be added later via Resend/SES.
// For now, we store notifications in the database and show them in the UI.

export async function notify({
  tenantId,
  userIds,
  title,
  message,
  type,
  link,
  refId,
  actorId,
}: {
  tenantId: string;
  userIds: string[];
  title: string;
  message: string;
  type: "approval" | "transition" | "checkout" | "eco" | "system";
  link?: string;
  refId?: string;
  /** The user whose action triggered this notification. Omit for system events. */
  actorId?: string;
}) {
  const db = getServiceClient();
  const now = new Date().toISOString();
  const { v4: uuid } = await import("uuid");

  // Don't notify the actor about their own action — saves every caller
  // from having to filter themselves out.
  const recipients = actorId
    ? userIds.filter((id) => id !== actorId)
    : userIds;

  const notifications = recipients.map((userId) => ({
    id: uuid(),
    tenantId,
    userId,
    title,
    message,
    type,
    link: link || null,
    refId: refId || null,
    actorId: actorId || null,
    isRead: false,
    createdAt: now,
  }));

  if (notifications.length > 0) {
    await db.from("notifications").insert(notifications);
  }
}

/**
 * Notify about a file lifecycle transition. Consolidates the "broadcast
 * on Released/Obsolete, otherwise notify the creator" rule so every
 * code path that transitions a file (direct, workflow engine, legacy)
 * produces the same notification shape.
 *
 * Caller must already know the file's `createdById` and the acting
 * user's id — we don't re-query them here.
 */
export async function notifyFileTransition({
  tenantId,
  fileId,
  fileName,
  toStateName,
  actorId,
  actorFullName,
  createdById,
}: {
  tenantId: string;
  fileId: string;
  fileName: string;
  toStateName: string;
  actorId: string;
  actorFullName: string;
  createdById: string | null;
}) {
  const broadcastStates = ["Released", "Obsolete"];
  if (broadcastStates.includes(toStateName)) {
    const db = getServiceClient();
    const { data: tenantUsers } = await db
      .from("tenant_users")
      .select("id")
      .eq("tenantId", tenantId);
    const userIds = (tenantUsers || []).map((u) => u.id);
    if (userIds.length === 0) return;
    await notify({
      tenantId,
      userIds,
      title: `File ${toStateName.toLowerCase()}`,
      message: `${actorFullName} moved "${fileName}" to ${toStateName}`,
      type: "transition",
      link: `/vault?file=${fileId}`,
      refId: fileId,
      actorId,
    });
    return;
  }
  if (!createdById) return;
  await notify({
    tenantId,
    userIds: [createdById],
    title: `File moved to ${toStateName}`,
    message: `${actorFullName} moved "${fileName}" to ${toStateName}`,
    type: "transition",
    link: `/vault?file=${fileId}`,
    refId: fileId,
    actorId,
  });
}

/**
 * Mark all unread notifications for a given user that reference the
 * given entity (by refId) as read. Used when a user handles an approval
 * before they've opened the notification that told them about it —
 * the notification should no longer nag.
 */
export async function markNotificationsReadByRef({
  tenantId,
  userId,
  refId,
}: {
  tenantId: string;
  userId: string;
  refId: string;
}) {
  const db = getServiceClient();
  await db
    .from("notifications")
    .update({ isRead: true })
    .eq("tenantId", tenantId)
    .eq("userId", userId)
    .eq("refId", refId)
    .eq("isRead", false);
}

export async function notifyApprovalGroupMembers({
  tenantId,
  groupIds,
  title,
  message,
  link,
  refId,
  actorId,
}: {
  tenantId: string;
  groupIds: string[];
  title: string;
  message: string;
  link?: string;
  refId?: string;
  actorId?: string;
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
      refId,
      actorId,
    });
  }
}
