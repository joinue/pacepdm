import { NextResponse } from "next/server";
import { withTenant, notFound } from "@/lib/api-route";
import { z, uuid } from "@/lib/validation";

/**
 * Download an attachment.
 *
 * Redirects to a short-lived signed URL rather than streaming the bytes
 * through the function: the same approach the vault takes, and it keeps a
 * 25 MB PDF off the response path. Anyone signed in can read the change log,
 * so anyone signed in can open what a post carries.
 */

const BUCKET = "vault";
const SIGNED_URL_TTL_SECONDS = 60;
const ParamsSchema = z.object({ attachmentId: uuid });

export const GET = withTenant({ params: ParamsSchema }, async ({ db, params }) => {
  // lint-conventions-allow: child-table-direct-query — change_log_files is
  // tenant-scoped by the client, so this read cannot cross a tenant.
  const { data: file } = await db
    .from("change_log_files")
    .select("id, storageKey, fileName")
    .eq("id", params.attachmentId)
    .maybeSingle();
  if (!file) throw notFound("That attachment is not here");

  const { data, error } = await db.storage
    .from(BUCKET)
    .createSignedUrl(file.storageKey, SIGNED_URL_TTL_SECONDS, { download: file.fileName });
  if (error || !data?.signedUrl) {
    throw new Error(`Could not open ${file.fileName}: ${error?.message ?? "no signed URL"}`);
  }

  return NextResponse.redirect(data.signedUrl);
});
