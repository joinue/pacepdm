import { withTenant, notFound } from "@/lib/api-route";
import { z, uuid } from "@/lib/validation";

/**
 * "I've seen this."
 *
 * The read receipt is the half a group chat cannot do: engineering can see a
 * change landed, and sales can show they were told. Needs no permission
 * beyond a session — marking a post read is not a privilege.
 *
 * Idempotent by primary key (postId, userId): clicking twice, or two tabs,
 * writes one row.
 */

const ParamsSchema = z.object({ postId: uuid });

export const POST = withTenant({ params: ParamsSchema }, async ({ db, tenantUser, params }) => {
  const { data: post } = await db
    .from("change_log_posts")
    .select("id")
    .eq("id", params.postId)
    .is("deletedAt", null)
    .maybeSingle();
  if (!post) throw notFound("That post is not in the change log");

  // lint-conventions-allow: child-table-direct-query — keyed by the post just
  // read through the scoped client and by the caller's own id.
  const { error } = await db
    .from("change_log_reads")
    .upsert(
      { postId: post.id, userId: tenantUser.id, readAt: new Date().toISOString() },
      { onConflict: "postId,userId" }
    );
  if (error) throw new Error(`Could not mark it read: ${error.message}`);

  return { success: true };
});
