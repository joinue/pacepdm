import { getServiceClient } from "@/lib/db";
import { notify } from "@/lib/notifications";
import { v4 as uuid } from "uuid";

interface MentionContext {
  tenantId: string;
  mentionedById: string;
  mentionedByName: string;
  entityType: "approval_decision" | "file_version";
  entityId: string;
  comment: string;
  link?: string;
}

/**
 * Parse @mentions from comment text, persist them, and notify mentioned users.
 */
export async function processMentions(ctx: MentionContext): Promise<void> {
  const mentionedNames = parseMentionNames(ctx.comment);
  if (mentionedNames.length === 0) return;

  const db = getServiceClient();

  // Resolve names to tenant users
  const { data: users } = await db
    .from("tenant_users")
    .select("id, fullName")
    .eq("tenantId", ctx.tenantId)
    .eq("isActive", true)
    .in("fullName", mentionedNames);

  if (!users || users.length === 0) return;

  // Filter out self-mentions
  const mentionedUsers = users.filter((u) => u.id !== ctx.mentionedById);
  if (mentionedUsers.length === 0) return;

  // Persist mention records
  const mentions = mentionedUsers.map((u) => ({
    id: uuid(),
    tenantId: ctx.tenantId,
    userId: u.id,
    mentionedBy: ctx.mentionedById,
    entityType: ctx.entityType,
    entityId: ctx.entityId,
    comment: ctx.comment,
    createdAt: new Date().toISOString(),
  }));

  const { error } = await db.from("comment_mentions").insert(mentions);
  // Non-fatal — the comment itself is already saved, and losing the mention
  // record must not lose the comment. The notification below still goes out:
  // being told you were mentioned is the part the user actually sees, and it
  // does not depend on this row.
  if (error) {
    console.error(
      `[mentions] failed to record ${mentions.length} mention(s) on ${ctx.entityType} ${ctx.entityId}:`,
      error.message
    );
  }

  // Send notifications
  await notify({
    tenantId: ctx.tenantId,
    userIds: mentionedUsers.map((u) => u.id),
    title: `${ctx.mentionedByName} mentioned you in a comment`,
    message: ctx.comment.length > 120 ? ctx.comment.substring(0, 117) + "..." : ctx.comment,
    type: "system",
    link: ctx.link,
    refId: ctx.entityId,
    actorId: ctx.mentionedById,
  });
}

/**
 * Extract @Full Name patterns from text.
 * Matches @FirstName LastName (2–3 capitalized words after @).
 * The frontend inserts names from a dropdown, so format is predictable.
 */
export function parseMentionNames(text: string): string[] {
  const regex = /@([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+){1,2})/g;
  const names: string[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    names.push(match[1]);
  }
  return [...new Set(names)];
}
