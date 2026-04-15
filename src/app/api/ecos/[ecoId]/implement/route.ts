import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { notify, notifyFileTransition, sideEffect } from "@/lib/notifications";
import { createReleaseFromEco } from "@/lib/releases";

/**
 * POST /api/ecos/[ecoId]/implement
 *
 * Implements an APPROVED ECO atomically. The actual work — transitioning
 * each linked file from WIP to Released, stamping `file_versions.ecoId`,
 * writing audit rows, and flipping the ECO to IMPLEMENTED — runs inside
 * a Postgres function (`implement_eco`, see migration-011) so the entire
 * operation is one transaction.
 *
 * This route is intentionally thin: auth, permissions, RPC call, notify.
 * All validation that depends on row state lives in the function so it
 * can't drift between the route and the database.
 *
 * Why an RPC instead of looping in JS: the Supabase JS client doesn't
 * expose transactions, and a partial implementation (some files moved,
 * ECO still APPROVED) is the kind of state that's painful to recover
 * from in a manufacturing workflow. The function is the standard
 * answer to multi-row writes that need to commit-or-rollback.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ ecoId: string }> }
) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.ECO_EDIT)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { ecoId } = await params;
    const db = getServiceClient();

    // Pre-check tenant ownership so we can return 404 (vs. exposing a 500
    // from the RPC) when somebody guesses an ECO id from another tenant.
    // The function re-validates this internally as defense in depth.
    const { data: eco } = await db
      .from("ecos")
      .select("id, tenantId, status, ecoNumber, title, createdById")
      .eq("id", ecoId)
      .single();

    if (!eco || eco.tenantId !== tenantUser.tenantId) {
      return NextResponse.json({ error: "ECO not found" }, { status: 404 });
    }
    if (eco.status !== "APPROVED") {
      return NextResponse.json(
        { error: `Cannot implement ECO in status ${eco.status} — must be APPROVED` },
        { status: 400 }
      );
    }

    // Atomic implementation. Any failure inside the function rolls back
    // the entire transaction, including audit rows and file state.
    const { data: result, error: rpcError } = await db.rpc("implement_eco", {
      p_eco_id: ecoId,
      p_user_id: tenantUser.id,
    });

    if (rpcError) {
      console.error("implement_eco RPC failed:", rpcError);
      return NextResponse.json(
        { error: rpcError.message || "Failed to implement ECO" },
        { status: 400 }
      );
    }

    // Capture the release snapshot. Runs after implement_eco has
    // committed, so parts.revision / file.currentVersion / eco_items
    // are all in their post-implement state — exactly what we want to
    // freeze into the manifest. Failure here is non-fatal: the ECO is
    // already implemented and a missing release row is a documentation
    // gap, not a correctness problem.
    let releaseId: string | null = null;
    try {
      const release = await createReleaseFromEco({
        db,
        tenantId: tenantUser.tenantId,
        ecoId,
        userId: tenantUser.id,
      });
      releaseId = release?.id ?? null;
      if (release) {
        console.info(
          `[ecos/${ecoId}] release ${release.id} captured ` +
            `(${release.manifest.parts.length} parts, ` +
            `${release.manifest.files.length} files, ` +
            `${release.manifest.boms.length} boms)`
        );
      }
    } catch (err) {
      console.error(`[ecos/${ecoId}] release capture failed:`, err);
    }

    // Notify the ECO creator that their ECO is now in production.
    // notify() filters the actor out automatically, so the creator-
    // clicks-implement case produces no self-notification.
    if (eco.createdById) {
      await sideEffect(
        notify({
          tenantId: tenantUser.tenantId,
          userIds: [eco.createdById],
          title: `ECO ${eco.ecoNumber} implemented`,
          message: `${tenantUser.fullName} implemented ${eco.ecoNumber}: ${eco.title}`,
          type: "eco",
          link: `/ecos`,
          refId: ecoId,
          actorId: tenantUser.id,
        }),
        `notify ECO ${eco.ecoNumber} implementation`
      );
    }

    // Notify the creators of every affected file that it was just
    // released via this ECO. The RPC already transitioned the files —
    // this is the user-visible message that mirrors what the regular
    // transition route would have sent.
    //
    // Two sources of affected files: (1) direct file items on the ECO,
    // and (2) files linked through part_files to any part item on the
    // ECO. We collect both, de-dupe by file id, and send one notification
    // per file creator.
    type AffectedFile = { id: string; name: string; createdById: string | null };
    const affectedById = new Map<string, AffectedFile>();

    const { data: directFileRows } = await db
      .from("eco_items")
      .select("file:files!eco_items_fileId_fkey(id, name, createdById)")
      .eq("ecoId", ecoId)
      .not("fileId", "is", null);
    for (const row of directFileRows || []) {
      const file = row.file as unknown as AffectedFile | null;
      if (file) affectedById.set(file.id, file);
    }

    const { data: partItemRows } = await db
      .from("eco_items")
      .select("partId")
      .eq("ecoId", ecoId)
      .not("partId", "is", null);
    const partIds = (partItemRows || []).map((r) => r.partId).filter((x): x is string => !!x);
    if (partIds.length > 0) {
      const { data: partFileRows } = await db
        .from("part_files")
        .select("file:files!part_files_fileId_fkey(id, name, createdById)")
        .in("partId", partIds);
      for (const row of partFileRows || []) {
        const file = row.file as unknown as AffectedFile | null;
        if (file) affectedById.set(file.id, file);
      }
    }

    for (const file of affectedById.values()) {
      await sideEffect(
        notifyFileTransition({
          tenantId: tenantUser.tenantId,
          fileId: file.id,
          fileName: file.name,
          toStateName: "Released",
          actorId: tenantUser.id,
          actorFullName: tenantUser.fullName,
          createdById: file.createdById,
        }),
        `notify ECO-implement transition of file ${file.id}`
      );
    }

    return NextResponse.json({ ...(result as object), releaseId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to implement ECO";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
