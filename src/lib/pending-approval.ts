import { getServiceClient } from "@/lib/db";

/**
 * A file is locked against change while a lifecycle transition on it is
 * awaiting approval.
 *
 * Reviewers approve the file as it stood when the request went out, but the
 * approval engine releases — and freezes — whatever the file holds when the
 * last decision lands. Without this lock, two things went wrong in production:
 *
 *   - A version checked in mid-review was what got released, unreviewed.
 *   - A checkout still open when the approval completed left a file both
 *     frozen and checked out. Check-in, transition, delete and upload-version
 *     all refuse that combination, so only SQL could free it.
 *
 * Only PENDING locks. REWORK exists precisely so the requester can change the
 * file before resubmitting, and RECALLED, REJECTED and APPROVED are finished.
 *
 * Returns the refusal message, or null when the file is free to change. A
 * failed lookup throws rather than returning null: failing open here is the
 * bug this exists to close.
 *
 * @param action what the caller was refused, phrased to follow "cannot be" —
 *   e.g. "checked out", "given a new version".
 */
export async function pendingApprovalRefusal(
  tenantId: string,
  fileId: string,
  action: string
): Promise<string | null> {
  const { data, error } = await getServiceClient()
    .from("approval_requests")
    .select("id, title")
    .eq("tenantId", tenantId)
    .eq("entityType", "file")
    .eq("entityId", fileId)
    .eq("status", "PENDING")
    .limit(1);

  if (error) {
    throw new Error(`Could not check whether the file is awaiting approval: ${error.message}`);
  }

  const pending = (data ?? [])[0] as { id: string; title: string | null } | undefined;
  if (!pending) return null;

  const which = pending.title ? ` ("${pending.title}")` : "";
  return (
    `This file is awaiting approval${which}, so it cannot be ${action} until ` +
    `that request is approved, rejected or recalled.`
  );
}
