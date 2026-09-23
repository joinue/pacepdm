import { getServiceClient } from "@/lib/db";
import { notify } from "@/lib/notifications";
import { v4 as uuid } from "uuid";

interface MentionContext {
  tenantId: string;
  mentionedById: string;
  mentionedByName: string;
  entityType: "approval_decision" | "file_version" | "change_log_comment";
  entityId: string;
  comment: string;
  link?: string;
}

export interface MentionableUser {
  id: string;
  fullName: string;
}

/**
 * Find @mentions in comment text, persist them, and notify mentioned users.
 */
export async function processMentions(ctx: MentionContext): Promise<void> {
  if (!ctx.comment.includes("@")) return;

  const db = getServiceClient();

  // The workspace's people, then the comment is read against their actual
  // names. Guessing names from the text first — "@ followed by two or three
  // capitalised words" — then looking those up matched nothing for
  // "@John Smith Please review" (it looked up "John Smith Please"), for
  // anyone with a hyphen, an apostrophe or one name, and for any mention
  // not typed in title case.
  const { data: users } = await db
    .from("tenant_users")
    .select("id, fullName")
    .eq("tenantId", ctx.tenantId)
    .eq("isActive", true);

  const mentionedUsers = findMentionedUsers(ctx.comment, users ?? []).filter(
    (u) => u.id !== ctx.mentionedById
  );
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
    type: "mention",
    link: ctx.link,
    refId: ctx.entityId,
    actorId: ctx.mentionedById,
  });
}

/**
 * The users whose full name follows an `@` in the text, each once, in the
 * order first mentioned.
 *
 * A name matches case-insensitively and only as a whole: "@Jo" is not Jo
 * Bloggs, and "@Jo Bloggs" is not Jo. Where two names could both start at
 * the same `@` — "Ann" and "Ann Lee" — the longer wins, so "@Ann Lee" is one
 * mention, not two. Nothing about the shape of a name is assumed: hyphens,
 * apostrophes, accents and single names all work, because the names come
 * from the workspace rather than from a pattern.
 */
export function findMentionedUsers<T extends MentionableUser>(text: string, users: T[]): T[] {
  const candidates = users
    .filter((u) => u.fullName.trim().length > 0)
    .map((u) => ({ user: u, name: u.fullName.trim().toLowerCase() }))
    .sort((a, b) => b.name.length - a.name.length);
  if (candidates.length === 0) return [];

  const lower = text.toLowerCase();
  const found: T[] = [];
  const seen = new Set<string>();

  for (let at = lower.indexOf("@"); at !== -1; at = lower.indexOf("@", at + 1)) {
    const rest = lower.slice(at + 1);
    for (const { user, name } of candidates) {
      if (!rest.startsWith(name)) continue;
      if (!isNameBoundary(rest.charAt(name.length))) continue;
      if (!seen.has(user.id)) {
        seen.add(user.id);
        found.push(user);
      }
      break;
    }
  }
  return found;
}

/** Whether a name can end here: end of text, whitespace or punctuation. */
function isNameBoundary(next: string): boolean {
  return next === "" || !/[\p{L}\p{N}]/u.test(next);
}
