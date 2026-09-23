import { v4 as newId } from "uuid";
import { withTenant, badRequest, forbidden, notFound, unprocessable } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENTS_PER_POST,
  attachmentContentType,
  attachmentKey,
} from "@/lib/change-log";
import { z, uuid } from "@/lib/validation";

/**
 * The files that come with a change — a revised spec sheet, a supplier
 * letter, a price sheet. Up to five per post.
 *
 * Stored in the vault bucket under a `change-log/` prefix, and tracked in
 * `change_log_files` rather than `files`. These are snapshots of what was
 * sent, not controlled documents: putting them in the library would let an
 * uncontrolled PDF reach a release package, which is the whole thing the ECO
 * process exists to prevent.
 */

const BUCKET = "vault";
const ParamsSchema = z.object({ postId: uuid });

export const POST = withTenant(
  { permission: PERMISSIONS.CHANGELOG_POST, params: ParamsSchema },
  async ({ db, tenantUser, params, request }) => {
    const { data: post } = await db
      .from("change_log_posts")
      .select("id, authorId")
      .eq("id", params.postId)
      .is("deletedAt", null)
      .maybeSingle();
    if (!post) throw notFound("That post is not in the change log");
    if (post.authorId !== tenantUser.id) {
      throw forbidden("Only the person who wrote a post can attach a file to it.");
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw badRequest("Expected a multipart form with a `file` field");
    }
    const file = form.get("file");
    if (!(file instanceof File)) throw badRequest("Missing file");
    if (file.size === 0) throw badRequest("That file is empty");
    if (file.size > ATTACHMENT_MAX_BYTES) {
      throw unprocessable(
        `That file is too large (max ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)} MB). ` +
          `Something bigger belongs in the vault, with a link to it in the post.`
      );
    }
    const contentType = attachmentContentType(file.name);
    if (!contentType) {
      throw unprocessable(
        `${file.name} cannot be attached here — PDFs, images, text, CSV, ` +
          `Excel, Word and PowerPoint files can.`
      );
    }

    const { count, error: countError } = await db
      .from("change_log_files")
      .select("id", { count: "exact", head: true })
      .eq("postId", post.id);
    if (countError) throw new Error(`Could not count attachments: ${countError.message}`);
    if ((count ?? 0) >= ATTACHMENTS_PER_POST) {
      throw unprocessable(
        `A post can carry ${ATTACHMENTS_PER_POST} files. ` +
          `More than that belongs in the vault, with a link to it in the post.`
      );
    }

    const id = newId();
    const key = attachmentKey(tenantUser.tenantId, post.id, id, file.name);

    const { error: uploadError } = await db.storage
      .from(BUCKET)
      .upload(key, file, { contentType, upsert: false });
    if (uploadError) throw new Error(`Could not store ${file.name}: ${uploadError.message}`);

    const { data: row, error } = await db
      .from("change_log_files")
      .insert({
        id,
        postId: post.id,
        storageKey: key,
        fileName: file.name,
        contentType,
        sizeBytes: file.size,
        uploadedById: tenantUser.id,
        createdAt: new Date().toISOString(),
      })
      .select("id, postId, fileName, sizeBytes")
      .single();
    if (error) {
      // The blob would otherwise sit in storage with nothing pointing at it.
      await db.storage.from(BUCKET).remove([key]);
      throw new Error(`Could not attach ${file.name}: ${error.message}`);
    }

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "changelog.attach",
      entityType: "change_log_post",
      entityId: post.id,
      details: { fileName: file.name, sizeBytes: file.size },
    });

    return row;
  }
);
