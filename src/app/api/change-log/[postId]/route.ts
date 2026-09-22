import { withTenant, badRequest, forbidden, notFound } from "@/lib/api-route";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { POST_MAX_LENGTH, postLines } from "@/lib/change-log";
import { z, nonEmptyString, uuid } from "@/lib/validation";

/**
 * Editing and withdrawing a post.
 *
 * People argue from this feed, so an edit is marked (`editedAt`, shown beside
 * the post) and a withdrawal is a soft delete: the row and its attachments
 * stay, the feed stops showing it. Only the author edits their own words;
 * an admin can withdraw anyone's, which is the usual "someone posted customer
 * pricing" case.
 */

const ParamsSchema = z.object({ postId: uuid });
const EditSchema = z.object({
  body: nonEmptyString.max(POST_MAX_LENGTH, `Keep it under ${POST_MAX_LENGTH} characters`),
});

const POST_COLUMNS =
  "id, body, category, createdAt, editedAt, partId, fileId, ecoId, releaseId, authorId, " +
  "author:tenant_users!change_log_posts_authorId_fkey(fullName)";

export const PATCH = withTenant(
  { permission: PERMISSIONS.CHANGELOG_POST, body: EditSchema, params: ParamsSchema },
  async ({ db, tenantUser, params, body }) => {
    const { data: post } = await db
      .from("change_log_posts")
      .select("id, authorId")
      .eq("id", params.postId)
      .is("deletedAt", null)
      .maybeSingle();
    if (!post) throw notFound("That post is not in the change log");
    if (post.authorId !== tenantUser.id) {
      throw forbidden("Only the person who wrote a post can edit it.");
    }
    if (postLines(body.body).length === 0) throw badRequest("Say what changed.");

    const { data: updated, error } = await db
      .from("change_log_posts")
      .update({ body: body.body.trim(), editedAt: new Date().toISOString() })
      .eq("id", post.id)
      .select(POST_COLUMNS)
      .single();
    if (error) throw new Error(`Could not edit the post: ${error.message}`);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "changelog.edit",
      entityType: "change_log_post",
      entityId: post.id,
      details: {},
    });

    return updated;
  }
);

export const DELETE = withTenant(
  { permission: PERMISSIONS.CHANGELOG_POST, params: ParamsSchema },
  async ({ db, tenantUser, params, permissions }) => {
    const { data: post } = await db
      .from("change_log_posts")
      .select("id, authorId")
      .eq("id", params.postId)
      .is("deletedAt", null)
      .maybeSingle();
    if (!post) throw notFound("That post is not in the change log");

    const isAdmin = hasPermission(permissions, "*");
    if (post.authorId !== tenantUser.id && !isAdmin) {
      throw forbidden("Only the person who wrote a post, or an admin, can withdraw it.");
    }

    const { error } = await db
      .from("change_log_posts")
      .update({ deletedAt: new Date().toISOString() })
      .eq("id", post.id);
    if (error) throw new Error(`Could not withdraw the post: ${error.message}`);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "changelog.withdraw",
      entityType: "change_log_post",
      entityId: post.id,
      details: { wasAuthor: post.authorId === tenantUser.id },
    });

    return { success: true };
  }
);
