import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Whether a tenant permits an approver to approve a request they authored.
 *
 * Permitted by default. A hard block deadlocks a team this size — the author is
 * frequently the only person holding `eco.approve` who is at their desk, and
 * what actually happens under a hard block is that they ask a colleague to
 * click approve on something they have not read, which is worse because it
 * launders it. See docs/decisions/self-approval.md.
 *
 * This lives in one file, and both callers use it, because there are **two**
 * independent paths to deciding an ECO:
 *
 *   1. The approval engine, when a workflow is assigned to the trigger.
 *   2. A direct status update on `PUT /api/ecos/[ecoId]`, which is what runs
 *      when no workflow is assigned — and no tenant is seeded with an ECO
 *      workflow, so in practice this is the common path.
 *
 * A rule applied to one of two paths that need it is the most common defect
 * shape in this codebase: it is what finding 2 of the functional audit was, and
 * finding 6, and it is why `permissionsExceedingActor` had to be added to a
 * second caller. Adding a third decision path means adding this check to it.
 */

/** The tenant settings key. Absent or false means self-approval is allowed. */
export const BLOCK_SELF_APPROVAL_KEY = "blockSelfApproval";

/**
 * Read the tenant's setting. Defaults to `false` — permitting self-approval —
 * on a missing row, a missing key, or a read failure.
 *
 * Failing open is deliberate and worth stating, because the reflex for a
 * governance check is to fail closed. This setting is a **process preference**,
 * not a security control: every real gate around an approval is enforced
 * separately and is unaffected by it — the `eco.approve` permission, approval
 * group membership, and the one-vote-per-person compare-and-swap. A Supabase
 * blip should not block a legitimate approver from doing their job on the
 * strength of a setting the tenant probably has not turned on.
 */
export async function blocksSelfApproval(db: SupabaseClient, tenantId: string): Promise<boolean> {
  const { data } = await db.from("tenants").select("settings").eq("id", tenantId).maybeSingle();
  const settings = (data?.settings as Record<string, unknown> | null) ?? {};
  return settings[BLOCK_SELF_APPROVAL_KEY] === true;
}

/**
 * The refusal message. Names the setting, because otherwise a user who holds
 * the permission and sits in the group reads the refusal as a bug.
 */
export function selfApprovalRefusal(action: "approve" | "decide" = "approve"): string {
  return (
    `You raised this request, and this workspace does not allow approvers to ` +
    `${action} their own. An admin can change that under Admin → Settings ` +
    `("Block self-approval").`
  );
}
