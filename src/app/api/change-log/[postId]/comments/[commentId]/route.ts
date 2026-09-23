import { withTenant, forbidden, notFound } from "@/lib/api-route";
import { hasPermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { COMMENT_COLUMNS, COMMENT_MAX_LENGTH } from "@/lib/change-log";
import { z, nonEmptyString, uuid } from "@/lib/validation";
import type { ScopedDb } from "@/lib/tenant-db";

/**
 * Editing and withdrawing a reply — the same rules as the post above it.
 * People argue from this feed, so an edit is marked and a withdrawal is a
 * soft delete. Only the author edits their words; an author or an admin
 * withdraws.
 */

const ParamsSchema = z.object({ postId: uuid, commentId: uuid });
const EditSchema = z.object({
  body: nonEmptyString.max(COMMENT_MAX_LENGTH, `Keep it under ${COMMENT_MAX_LENGTH} characters`),
});

async function loadComment(db: ScopedDb, params: { postId: string; commentId: string }) {
  const { data: comment } = await db
    .from("change_log_comments")
    .select("id, postId, authorId")
    .eq("id", params.commentId)
    .eq("postId", params.postId)
    .is("deletedAt", null)
    .maybeSingle();
  if (!comment) throw notFound("That reply is no longer in the thread");
  return comment as { id: string; postId: string; authorId: string | null };
}

export const PATCH = withTenant(
  { body: EditSchema, params: ParamsSchema },
  async ({ db, tenantUser, params, body }) => {
    const comment = await loadComment(db, params);
    if (comment.authorId !== tenantUser.id) {
      throw forbidden("Only the person who wrote a reply can edit it.");
    }

    const { data: updated, error } = await db
      .from("change_log_comments")
      .update({ body: body.body.trim(), editedAt: new Date().toISOString() })
      .eq("id", comment.id)
      .select(COMMENT_COLUMNS)
      .single();
    if (error) throw new Error(`Could not edit the reply: ${error.message}`);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "changelog.comment_edit",
      entityType: "change_log_post",
      entityId: comment.postId,
      details: { commentId: comment.id },
    });

    return updated;
  }
);

export const DELETE = withTenant(
  { params: ParamsSchema },
  async ({ db, tenantUser, params, permissions }) => {
    const comment = await loadComment(db, params);
    const isAdmin = hasPermission(permissions, "*");
    if (comment.authorId !== tenantUser.id && !isAdmin) {
      throw forbidden("Only the person who wrote a reply, or an admin, can withdraw it.");
    }

    const { error } = await db
      .from("change_log_comments")
      .update({ deletedAt: new Date().toISOString() })
      .eq("id", comment.id);
    if (error) throw new Error(`Could not withdraw the reply: ${error.message}`);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "changelog.comment_withdraw",
      entityType: "change_log_post",
      entityId: comment.postId,
      details: { commentId: comment.id, wasAuthor: comment.authorId === tenantUser.id },
    });

    return { success: true };
  }
);
