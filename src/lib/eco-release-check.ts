// What implementing an ECO will release, and what would stop it releasing
// what the reviewers approved.
//
// `implement_eco` (migration 049) releases each file the ECO lists, and each
// file linked to a part it lists, but only a file it finds in WIP and not
// checked out. Anything else it skipped without a word — while still stamping
// the file's version with the ECO and, for a listed file, writing an audit row
// that said it had transitioned. It also released files and parts sitting in
// the trash. The ECO went to IMPLEMENTED regardless (AUD-003 CHG-2).
//
// It also bumped each listed part's revision itself when the item named none,
// with `chr(ascii + 1)`: R3, 01 and Z made it raise, and the letters it landed
// on included the reserved I, O, Q, S and X. An explicit revision was never
// checked. Once approved, an ECO that failed there could not be implemented,
// edited or deleted (AUD-003 CHG-3). The revision a part becomes is now worked
// out here, with the rules in `revision.ts`, and written onto the item at
// submission so the approvers see it; the function only applies it.
//
// This runs the same selection in advance and names every file or part the
// function would mishandle. It is checked when an ECO is submitted — the
// cheapest moment to fix any of it, and from then on the content lock in
// `eco-content-lock.ts` keeps it that way — and again before implementing, for
// ECOs submitted before that lock existed. With nothing blocking, what the
// function does and what it reports agree.

import { getServiceClient } from "@/lib/db";
import { selectAll, selectAllIn } from "@/lib/paged-query";
import { nextRevision, revisionTargetProblem } from "@/lib/revision";

export interface EcoReleasePlan {
  /** Files implement will move from WIP to Released. */
  filesToRelease: { id: string; name: string; createdById: string | null }[];
  /** Each thing that would stop implement doing what was approved, as a sentence. */
  blockers: string[];
  /**
   * Part items with no "To revision", and the revision each will become. The
   * caller writes these onto the items (`fillPartRevisions`) before the ECO
   * moves on, so what is approved and what is released are the same letter.
   */
  revisionsToFill: { itemId: string; partNumber: string; toRevision: string }[];
}

interface ItemRow {
  id: string;
  fileId: string | null;
  partId: string | null;
  toRevision: string | null;
}
interface PartRow {
  id: string;
  partNumber: string;
  revision: string | null;
  deletedAt: string | null;
}
interface LinkRow {
  id: string;
  partId: string;
  fileId: string;
}
interface FileRow {
  id: string;
  name: string;
  lifecycleState: string;
  isCheckedOut: boolean;
  deletedAt: string | null;
  createdById: string | null;
  // A to-one join, which the client's types describe as an array.
  checkedOutBy: { fullName: string | null } | { fullName: string | null }[] | null;
}

/**
 * @param moment "submit" or "implement" — only changes what the messages tell
 *   the user to do, since a submitted ECO's files can no longer be checked in.
 */
export async function checkEcoRelease(
  tenantId: string,
  ecoId: string,
  moment: "submit" | "implement"
): Promise<EcoReleasePlan> {
  const db = getServiceClient();
  const blockers: string[] = [];

  // lint-conventions-allow: child-table-direct-query — this module uses the
  // service client, and every child read below is keyed by ids that came from
  // an ECO the caller loaded through the scoped client; parts, files and
  // requests are additionally filtered by tenant.
  const items = await selectAll<ItemRow>((from, to) =>
    db
      .from("eco_items")
      .select("id, fileId, partId, toRevision")
      .eq("ecoId", ecoId)
      .order("id")
      .range(from, to)
  );

  const partIds = [...new Set(items.map((i) => i.partId).filter((x): x is string => !!x))];
  const directFileIds = new Set(items.map((i) => i.fileId).filter((x): x is string => !!x));

  const [parts, links] = await Promise.all([
    selectAllIn<PartRow>(partIds, (chunk, from, to) =>
      db
        .from("parts")
        .select("id, partNumber, revision, deletedAt")
        .eq("tenantId", tenantId)
        .in("id", chunk)
        .order("id")
        .range(from, to)
    ),
    selectAllIn<LinkRow>(partIds, (chunk, from, to) =>
      db
        .from("part_files")
        .select("id, partId, fileId")
        .in("partId", chunk)
        .order("id")
        .range(from, to)
    ),
  ]);

  const partNumberById = new Map(parts.map((p) => [p.id, p.partNumber]));
  const partById = new Map(parts.map((p) => [p.id, p]));
  const revisionsToFill: EcoReleasePlan["revisionsToFill"] = [];
  // Once submitted, an item can only be changed by taking the ECO back to draft.
  const reopen =
    moment === "submit"
      ? "Remove the part from the ECO and add it again"
      : "Have an approver reject the ECO, reopen it as a draft, and add the part again";

  for (const part of parts) {
    if (part.deletedAt) {
      blockers.push(
        `Part ${part.partNumber} is in the trash. Restore it, or remove it from the ECO.`
      );
    }
  }

  for (const item of items) {
    const part = item.partId ? partById.get(item.partId) : undefined;
    if (!part || part.deletedAt) continue;

    const current = (part.revision ?? "").trim();
    const explicit = (item.toRevision ?? "").trim();
    const target = explicit || nextRevision(current)?.next;

    if (!target) {
      blockers.push(
        (current
          ? `Part ${part.partNumber} is at revision ${current}, which cannot be followed on from automatically. `
          : `Part ${part.partNumber} has no revision to follow on from. `) +
          `${reopen} with the revision it should become.`
      );
      continue;
    }

    const problem = revisionTargetProblem(current, target);
    if (problem) {
      blockers.push(
        `Part ${part.partNumber} is at revision ${current}, so it cannot be released as ` +
          `${problem === "same" ? "the same revision" : `revision ${target}, which comes before it`}. ` +
          `${reopen} with a later revision.`
      );
      continue;
    }

    if (!explicit) {
      revisionsToFill.push({ itemId: item.id, partNumber: part.partNumber, toRevision: target });
    }
  }

  /** For a file reached only through a part, which part — for the message. */
  const viaPart = new Map<string, string>();
  for (const link of links) {
    if (!directFileIds.has(link.fileId) && !viaPart.has(link.fileId)) {
      viaPart.set(link.fileId, partNumberById.get(link.partId) ?? "a part on this ECO");
    }
  }
  const fileIds = [...new Set([...directFileIds, ...links.map((l) => l.fileId)])];

  const [files, pendingRequests] = await Promise.all([
    selectAllIn<FileRow>(fileIds, (chunk, from, to) =>
      db
        .from("files")
        .select(
          "id, name, lifecycleState, isCheckedOut, deletedAt, createdById, checkedOutBy:tenant_users!files_checkedOutById_fkey(fullName)"
        )
        .eq("tenantId", tenantId)
        .in("id", chunk)
        .order("id")
        .range(from, to)
    ),
    selectAllIn<{ id: string; entityId: string }>(fileIds, (chunk, from, to) =>
      db
        .from("approval_requests")
        .select("id, entityId")
        .eq("tenantId", tenantId)
        .eq("entityType", "file")
        .in("entityId", chunk)
        .eq("status", "PENDING")
        .order("id")
        .range(from, to)
    ),
  ]);

  const awaitingApproval = new Set(pendingRequests.map((r) => r.entityId));
  const filesToRelease: EcoReleasePlan["filesToRelease"] = [];

  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const part = viaPart.get(file.id);
    const label = part ? `${file.name} (linked to ${part})` : file.name;
    const detach = part ? `unlink it from ${part}` : "remove it from the ECO";

    if (file.deletedAt) {
      blockers.push(`${label} is in the trash. Restore it, or ${detach}.`);
    } else if (file.isCheckedOut) {
      const holder = Array.isArray(file.checkedOutBy) ? file.checkedOutBy[0] : file.checkedOutBy;
      const who = holder?.fullName ?? "someone";
      blockers.push(
        moment === "submit"
          ? `${label} is checked out by ${who}. Check it in first — once the ECO is submitted, its files are locked.`
          : `${label} is checked out by ${who}. Undo the checkout, or, if it holds changes the ECO needs, have an approver reject the ECO so it can be reopened.`
      );
    } else if (awaitingApproval.has(file.id)) {
      blockers.push(
        `${label} has a lifecycle change awaiting approval. Have it decided or recalled first.`
      );
    } else if (file.lifecycleState === "WIP") {
      filesToRelease.push({ id: file.id, name: file.name, createdById: file.createdById });
    } else if (file.lifecycleState !== "Released") {
      // `implement_eco` releases from WIP only and leaves any other state
      // untouched. Already Released is fine — that version is what is released.
      blockers.push(
        `${label} is ${file.lifecycleState}. Implementing releases files from WIP and leaves ` +
          `any other state as it is, so ` +
          (moment === "submit"
            ? `move it back to WIP, or ${detach}.`
            : `have an approver reject the ECO so it can be reopened, then move it back to WIP or ${detach}.`)
      );
    }
  }

  return { filesToRelease, blockers, revisionsToFill };
}

/**
 * Record the revisions `checkEcoRelease` worked out on the items that named
 * none. Keyed by the ECO as well as the item, so a stray item id cannot reach
 * another ECO's rows.
 *
 * Throws on a failed write: the database function refuses a part item with no
 * revision, so carrying on would only fail later with a vaguer message.
 */
export async function fillPartRevisions(
  ecoId: string,
  fills: EcoReleasePlan["revisionsToFill"]
): Promise<void> {
  const db = getServiceClient();
  for (const fill of fills) {
    const { error } = await db
      .from("eco_items")
      .update({ toRevision: fill.toRevision })
      .eq("id", fill.itemId)
      .eq("ecoId", ecoId);
    if (error) {
      throw new Error(
        `Could not record revision ${fill.toRevision} for part ${fill.partNumber}: ${error.message}`
      );
    }
  }
}

/** One message naming the first few blockers, for an error the user reads. */
export function describeBlockers(subject: string, blockers: string[]): string {
  const shown = blockers.slice(0, 4);
  const more = blockers.length - shown.length;
  return (
    `${subject}: ${shown.join(" ")}` + (more > 0 ? ` And ${more} more — see the details.` : "")
  );
}
