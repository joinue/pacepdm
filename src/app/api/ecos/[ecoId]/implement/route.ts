import { withTenant, badRequest, conflict, notFound } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { notify, sideEffect } from "@/lib/notifications";
import { createReleaseFromEco } from "@/lib/releases";
import { checkEcoRelease, describeBlockers, fillPartRevisions } from "@/lib/eco-release-check";
import { z, uuid } from "@/lib/validation";

/**
 * POST /api/ecos/[ecoId]/implement
 *
 * Implements an APPROVED ECO atomically. The work — releasing each listed
 * file, each file linked to a listed part, and each carried BOM; bumping part
 * revisions; stamping `file_versions.ecoId`; writing audit rows; and moving
 * the ECO to IMPLEMENTED — runs inside the `implement_eco` Postgres function
 * (migration 049), so it commits or rolls back as one.
 *
 * Before calling it, `checkEcoRelease` names anything the function would
 * mishandle: it skipped, without saying so, a file checked out or in any state
 * but WIP, and released files and parts from the trash — while the ECO still
 * went to IMPLEMENTED and the toast counted what it did (AUD-003 CHG-2). Those
 * now refuse here with the reason, and the ECO stays APPROVED — from where an
 * approver can reject it to reopen it (AUD-003 CHG-3).
 *
 * The function no longer works out a part's next revision (migration 056); the
 * item carries it, written at submission. An ECO submitted before that has it
 * written here instead, by the same rules.
 */
export const POST = withTenant(
  { permission: PERMISSIONS.ECO_EDIT, params: z.object({ ecoId: uuid }) },
  async ({ db, tenantUser, params }) => {
    const { ecoId } = params;

    const { data: eco } = await db
      .from("ecos")
      .select("id, status, ecoNumber, title, createdById")
      .eq("id", ecoId)
      .is("deletedAt", null)
      .maybeSingle();
    if (!eco) throw notFound("ECO not found");
    if (eco.status !== "APPROVED") {
      throw badRequest(`Cannot implement ECO in status ${eco.status} — must be APPROVED`);
    }

    const plan = await checkEcoRelease(tenantUser.tenantId, ecoId, "implement");
    if (plan.blockers.length > 0) {
      throw conflict(
        describeBlockers(`${eco.ecoNumber} cannot be implemented yet`, plan.blockers),
        {
          blockers: plan.blockers,
        }
      );
    }

    await fillPartRevisions(ecoId, plan.revisionsToFill);

    const { data: result, error: rpcError } = await db.rpc("implement_eco", {
      p_eco_id: ecoId,
      p_user_id: tenantUser.id,
    });
    if (rpcError) {
      console.error("implement_eco RPC failed:", rpcError);
      throw badRequest(rpcError.message || "Failed to implement ECO");
    }

    const released = (result as { filesTransitioned?: number } | null)?.filesTransitioned ?? 0;
    if (released !== plan.filesToRelease.length) {
      console.warn(
        `[ecos/${ecoId}] implement released ${released} file(s) but ${plan.filesToRelease.length} ` +
          `were expected to move from WIP`
      );
    }

    // The release snapshot. Runs after implement_eco has committed, so it
    // freezes the post-implement state. A failure here is not fatal to the
    // implementation, which has already happened.
    let releaseId: string | null = null;
    try {
      const release = await createReleaseFromEco({
        db: db.unscoped("createReleaseFromEco filters every read by the tenantId it is given"),
        tenantId: tenantUser.tenantId,
        ecoId,
        userId: tenantUser.id,
      });
      releaseId = release?.id ?? null;
      const rpcBoms = (result as { bomsReleased?: number } | null)?.bomsReleased ?? 0;
      if (release && rpcBoms > release.manifest.boms.length) {
        console.warn(
          `[ecos/${ecoId}] implement released ${rpcBoms} BOM(s) but only ` +
            `${release.manifest.boms.length} reached the manifest`
        );
      }
    } catch (err) {
      console.error(`[ecos/${ecoId}] release capture failed:`, err);
    }

    // One notification per person for the whole implementation. A file
    // reaching Released is broadcast to the workspace, and this used to go
    // through that path once per file — an ECO releasing twenty files put
    // twenty rows and twenty emails in front of everyone, plus one more for
    // the author. The count says what moved without naming files, so nothing
    // leaks from a folder the reader cannot open. notify() drops the actor.
    const { data: members } = await db.from("tenant_users").select("id").eq("isActive", true);
    const memberIds = (members ?? []).map((m: { id: string }) => m.id);
    const releasedNote =
      plan.filesToRelease.length > 0
        ? ` — ${plan.filesToRelease.length} file${plan.filesToRelease.length === 1 ? "" : "s"} released`
        : "";
    await sideEffect(
      notify({
        tenantId: tenantUser.tenantId,
        userIds: memberIds,
        title: `ECO ${eco.ecoNumber} implemented`,
        message: `${tenantUser.fullName} implemented ${eco.ecoNumber}: ${eco.title}${releasedNote}`,
        type: "eco",
        link: `/ecos/${ecoId}`,
        refId: ecoId,
        actorId: tenantUser.id,
      }),
      `notify ECO ${eco.ecoNumber} implementation`
    );

    return { ...(result as object), releaseId };
  }
);
