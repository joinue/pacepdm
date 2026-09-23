import { v4 as newId } from "uuid";
import { withTenant, badRequest } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { notify, sideEffect } from "@/lib/notifications";
import { selectAll, selectAllIn } from "@/lib/paged-query";
import {
  COMMENT_COLUMNS,
  DEFAULT_CATEGORY,
  POST_MAX_LENGTH,
  categoryLabel,
  isChangeLogCategory,
  postLines,
} from "@/lib/change-log";
import { z, nonEmptyString, optionalString } from "@/lib/validation";

/**
 * The change log — what engineering changed, for the people who have to
 * answer customers about it.
 *
 * Reading needs nothing beyond a session: sales holds a read-only role, and a
 * feed sales cannot open is the email thread it replaces. Posting needs
 * CHANGELOG_POST.
 *
 * A post is a notice. It carries no status, gates nothing, and nothing waits
 * on it — the moment it can hold something up it is a second ECO.
 */

const PAGE_SIZE = 50;

const NewPostSchema = z.object({
  body: nonEmptyString.max(POST_MAX_LENGTH, `Keep it under ${POST_MAX_LENGTH} characters`),
  category: optionalString,
  /** What the post is about, when it is about a record. All optional. */
  partId: optionalString,
  fileId: optionalString,
  ecoId: optionalString,
  releaseId: optionalString,
});

const POST_COLUMNS =
  "id, body, category, createdAt, editedAt, partId, fileId, ecoId, releaseId, authorId, " +
  "author:tenant_users!change_log_posts_authorId_fkey(fullName)";

export const GET = withTenant({}, async ({ db, tenantUser }) => {
  const { data: posts, error } = await db
    .from("change_log_posts")
    .select(POST_COLUMNS)
    .is("deletedAt", null)
    .order("createdAt", { ascending: false })
    .limit(PAGE_SIZE);
  if (error) throw new Error(`Could not load the change log: ${error.message}`);

  const ids = (posts ?? []).map((post: { id: string }) => post.id);
  if (ids.length === 0) return { posts: [] };

  // Attachments, read receipts and replies for the page of posts being
  // shown. The whole thread comes with the post: replies are short and few,
  // and a thread that loads on a click is one nobody opens.
  // lint-conventions-allow: child-table-direct-query — keyed by the ids of
  // posts just read through the scoped client.
  const [attachments, reads, comments] = await Promise.all([
    selectAllIn<{ id: string; postId: string; fileName: string; sizeBytes: number | null }>(
      ids,
      (chunk, from, to) =>
        db
          .from("change_log_files")
          .select("id, postId, fileName, sizeBytes")
          .in("postId", chunk)
          .order("createdAt")
          .range(from, to)
    ),
    selectAllIn<{ postId: string; userId: string; reader: unknown }>(ids, (chunk, from, to) =>
      db
        .from("change_log_reads")
        .select("postId, userId, reader:tenant_users!change_log_reads_userId_fkey(fullName)")
        .in("postId", chunk)
        .order("postId")
        .range(from, to)
    ),
    selectAllIn<{ id: string; postId: string; createdAt: string }>(ids, (chunk, from, to) =>
      db
        .from("change_log_comments")
        .select(COMMENT_COLUMNS)
        .in("postId", chunk)
        .is("deletedAt", null)
        .order("createdAt")
        .range(from, to)
    ),
  ]);

  const filesByPost = new Map<string, typeof attachments>();
  for (const file of attachments) {
    filesByPost.set(file.postId, [...(filesByPost.get(file.postId) ?? []), file]);
  }
  const readsByPost = new Map<string, typeof reads>();
  for (const read of reads) {
    readsByPost.set(read.postId, [...(readsByPost.get(read.postId) ?? []), read]);
  }
  // Oldest first within a thread, whatever order the pages came back in.
  const commentsByPost = new Map<string, typeof comments>();
  for (const comment of comments) {
    commentsByPost.set(comment.postId, [...(commentsByPost.get(comment.postId) ?? []), comment]);
  }
  for (const thread of commentsByPost.values()) {
    thread.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  return {
    posts: (posts ?? []).map((post: Record<string, unknown>) => {
      const seen = readsByPost.get(post.id as string) ?? [];
      return {
        ...post,
        attachments: filesByPost.get(post.id as string) ?? [],
        comments: commentsByPost.get(post.id as string) ?? [],
        readBy: seen.map((r) => ({ userId: r.userId, reader: r.reader })),
        readByMe: seen.some((r) => r.userId === tenantUser.id),
      };
    }),
  };
});

export const POST = withTenant(
  { permission: PERMISSIONS.CHANGELOG_POST, body: NewPostSchema },
  async ({ db, tenantUser, body }) => {
    const category = body.category?.trim() || DEFAULT_CATEGORY;
    if (!isChangeLogCategory(category)) {
      throw badRequest(`"${category}" is not one of the change-log categories.`);
    }
    if (postLines(body.body).length === 0) {
      throw badRequest("Say what changed.");
    }

    const { data: post, error } = await db
      .from("change_log_posts")
      .insert({
        id: newId(),
        body: body.body.trim(),
        category,
        authorId: tenantUser.id,
        partId: body.partId ?? null,
        fileId: body.fileId ?? null,
        ecoId: body.ecoId ?? null,
        releaseId: body.releaseId ?? null,
        createdAt: new Date().toISOString(),
      })
      .select(POST_COLUMNS)
      .single();
    if (error) throw new Error(`Could not post: ${error.message}`);

    // Everyone active hears about it. A post nobody is told about is a wall
    // people are expected to remember to visit, which is what this replaces.
    const people = await selectAll<{ id: string }>((from, to) =>
      db.from("tenant_users").select("id").eq("isActive", true).order("id").range(from, to)
    );

    const firstLine = postLines(body.body)[0] ?? "";
    await sideEffect(
      notify({
        tenantId: tenantUser.tenantId,
        userIds: people.map((person) => person.id),
        title: `${categoryLabel(category)}: ${firstLine.slice(0, 80)}`,
        message: `${tenantUser.fullName ?? "Someone"} posted to the change log.`,
        type: "changelog",
        link: "/change-log",
        refId: post.id,
        actorId: tenantUser.id,
      }),
      "notify change log post"
    );

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "changelog.post",
      entityType: "change_log_post",
      entityId: post.id,
      details: { category, told: people.length },
    });

    return { ...post, attachments: [], comments: [], readBy: [], readByMe: false };
  }
);
