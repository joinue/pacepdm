import { v4 as newId } from "uuid";
import { withTenant, notFound } from "@/lib/api-route";
import { logAudit } from "@/lib/audit";
import { notify, sideEffect } from "@/lib/notifications";
import { processMentions } from "@/lib/mentions";
import { COMMENT_COLUMNS, COMMENT_MAX_LENGTH, postLines } from "@/lib/change-log";
import { z, nonEmptyString, uuid } from "@/lib/validation";

/**
 * Replying to a post.
 *
 * The post is a notice; the thread under it is where "does this affect the
 * order we have in flight?" gets asked and answered, next to the change, so
 * the next person with the question finds the answer. It used to be a reply
 * to the notification email, which put it in one inbox.
 *
 * Anyone with a session can reply — sales holds a read-only role and the
 * thread is for them. A reply tells the post's author and everyone already in
 * the thread, not the workspace: the post told everyone, and a reply that
 * told everyone again is the email chain this replaces. An @mention is told
 * as a mention, on top: that is the one way to pull in someone who is not in
 * the thread yet.
 */

const ParamsSchema = z.object({ postId: uuid });
const NewCommentSchema = z.object({
  body: nonEmptyString.max(COMMENT_MAX_LENGTH, `Keep it under ${COMMENT_MAX_LENGTH} characters`),
});

export const POST = withTenant(
  { params: ParamsSchema, body: NewCommentSchema },
  async ({ db, tenantUser, params, body }) => {
    const { data: post } = await db
      .from("change_log_posts")
      .select("id, authorId, body")
      .eq("id", params.postId)
      .is("deletedAt", null)
      .maybeSingle();
    if (!post) throw notFound("That post is not in the change log");

    const text = body.body.trim();

    // Who is in the thread already, before this reply joins it.
    const { data: earlier, error: earlierError } = await db
      .from("change_log_comments")
      .select("authorId")
      .eq("postId", post.id)
      .is("deletedAt", null);
    if (earlierError) throw new Error(`Could not read the thread: ${earlierError.message}`);

    const { data: comment, error } = await db
      .from("change_log_comments")
      .insert({
        id: newId(),
        postId: post.id,
        authorId: tenantUser.id,
        body: text,
        createdAt: new Date().toISOString(),
      })
      .select(COMMENT_COLUMNS)
      .single();
    if (error) throw new Error(`Could not reply: ${error.message}`);

    const thread = new Set<string>();
    if (post.authorId) thread.add(post.authorId);
    for (const reply of earlier ?? []) if (reply.authorId) thread.add(reply.authorId);
    // notify() leaves out the actor and anyone deactivated.
    const told = [...thread];

    const link = `/change-log?post=${post.id}`;
    const name = tenantUser.fullName ?? "Someone";
    const firstLine = postLines(post.body)[0] ?? "";

    await sideEffect(
      notify({
        tenantId: tenantUser.tenantId,
        userIds: told,
        title: `${name} replied on: ${firstLine.slice(0, 70)}`,
        message: text.length > 160 ? `${text.slice(0, 157)}...` : text,
        type: "changelog",
        link,
        refId: post.id,
        actorId: tenantUser.id,
      }),
      "notify change log reply"
    );
    await sideEffect(
      processMentions({
        tenantId: tenantUser.tenantId,
        mentionedById: tenantUser.id,
        mentionedByName: name,
        entityType: "change_log_comment",
        entityId: comment.id,
        comment: text,
        link,
      }),
      "change log reply mentions"
    );

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "changelog.comment",
      entityType: "change_log_post",
      entityId: post.id,
      details: { commentId: comment.id, told: told.length },
    });

    return comment;
  }
);
